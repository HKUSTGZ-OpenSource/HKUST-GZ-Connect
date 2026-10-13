'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserSessionManager, pacDataUrl } = require('../../../../lib/browser/session/browser-session-manager');

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const writes = [], handlers = [];
  const session = { webRequest: { onBeforeRequest: (_filter, handler) => handlers.push(handler) },
    setProxy: async config => writes.push(Buffer.from(config.pacScript.split(',')[1], 'base64').toString()),
    forceReloadProxyConfig: async () => {}, closeAllConnections: async () => {} };
  const proxyConfig = async port => ({ mode: 'pac_script',
    pacScript: pacDataUrl(`function FindProxyForURL(){return "SOCKS5 127.0.0.1:${port}";}`),
    proxyBypassRules: '<-loopback>' });
  const manager = options => new BrowserSessionManager({ session: { fromPartition: () => session },
    partition: 'persist:synthetic-session-ownership', routingPolicy: { proxyConfig }, ...options });
  const request = () => new Promise(resolve => handlers[0]({ url: 'https://synthetic.example.test/' }, resolve));
  return { session, writes, handlers, proxyConfig, manager, request };
}

test('a replacement Session manager owns readiness without installing a second request hook', async () => {
  const f = fixture(); let oldCalls = 0, currentCalls = 0;
  const old = f.manager({ ensureRequestReady: async () => { oldCalls++; return true; } });
  await old.configure(6180); await old.suspend();
  const current = f.manager({ ensureRequestReady: async () => { currentCalls++; return false; } });
  await current.configure(8180);
  assert.deepEqual(await f.request(), { cancel: true });
  assert.equal(oldCalls, 0); assert.equal(currentCalls, 1); assert.equal(f.handlers.length, 1);
});

test('queued request readiness cannot invoke either owner after replacement retires its admission', async () => {
  const f = fixture(); let oldCalls = 0, currentCalls = 0;
  const old = f.manager({ ensureRequestReady: async () => { oldCalls++; return true; } });
  await old.configure(6180);
  const current = f.manager({ ensureRequestReady: async () => { currentCalls++; return true; } });
  const configuring = current.configure(8180);
  const obsolete = f.request();
  await configuring;
  assert.deepEqual(await obsolete, { cancel: true });
  assert.equal(oldCalls, 0); assert.equal(currentCalls, 0);
  assert.deepEqual(await f.request(), { cancel: false }); assert.equal(currentCalls, 1);
});

for (const initial of [false, true]) {
  test(`${initial ? 'first' : 'later'} old PAC transition cannot overwrite a replacement Session manager`, async t => {
    const f = fixture(), entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const old = f.manager({ routingPolicy: { proxyConfig: async port => {
      if (port === 7180) { entered.resolve(); await release.promise; }
      return f.proxyConfig(port);
    } } });
    if (!initial) await old.configure(6180);
    const obsolete = old.configure(7180); await entered.promise;
    const current = f.manager(); const replacing = current.configure(8180);
    await new Promise(setImmediate); // Let replacement ownership, but not the held old read, advance.
    release.resolve();
    assert.equal(await obsolete, null);
    assert.equal(await replacing, f.session);
    assert.equal(current.configuredPort, 8180);
    assert.ok(f.writes.at(-1).includes(':8180'));
    assert.equal(f.writes.some(write => write.includes(':7180')), false);
  });
}

test('a retired manager cannot suspend, resume or reacquire another owner request/PAC authority', async () => {
  const f = fixture(), old = f.manager(), current = f.manager();
  await old.configure(6180); await current.configure(8180);
  const before = f.writes.length;
  assert.equal(await old.suspend(), null);
  assert.equal(await old.resume(7180), null);
  assert.equal(await old.configure(9180), null);
  assert.equal(f.writes.length, before);
  assert.equal(old.requestsBlocked, true);
  assert.equal(current.requestsBlocked, false);
  assert.deepEqual(await f.request(), { cancel: false });
});

test('already-issued native I/O finishes before the replacement owner commits its PAC', async t => {
  const f = fixture(), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let completed = 0;
  f.session.setProxy = async config => {
    const pac = Buffer.from(config.pacScript.split(',')[1], 'base64').toString();
    if (pac.includes(':7180')) { entered.resolve(); await release.promise; }
    f.writes.push(pac); completed++;
  };
  const old = f.manager(); const obsolete = old.configure(7180); await entered.promise;
  const current = f.manager(); const replacing = current.configure(8180);
  await new Promise(setImmediate);
  assert.equal(completed, 0, 'replacement native I/O must wait for the shared Session transition');
  release.resolve(); assert.equal(await obsolete, null); await replacing;
  assert.ok(f.writes.at(-1).includes(':8180'));
});

test('a retired read-only policy preparation cannot stall the replacement native transition', async t => {
  const f = fixture(), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const old = f.manager({ routingPolicy: { proxyConfig: async port => {
    entered.resolve(); await release.promise; return f.proxyConfig(port);
  } } });
  const obsolete = old.configure(7180); await entered.promise;
  const current = f.manager(); let completed = false;
  const replacing = current.configure(8180).then(value => { completed = true; return value; });
  await new Promise(setImmediate);
  assert.equal(completed, true, 'only already-issued native I/O may delay the replacement');
  release.resolve(); assert.equal(await obsolete, null); assert.equal(await replacing, f.session);
});

test('explicit retirement is synchronous and repeatable, and cannot block a replacement owner', async () => {
  const f = fixture(), old = f.manager({ ensureRequestReady: async () => true });
  await old.configure(6180);
  const queued = f.request();
  assert.equal(old.retire(), true); assert.equal(old.retire(), false);
  assert.equal(old.requestsBlocked, true); assert.deepEqual(await queued, { cancel: true });
  const before = f.writes.length;
  assert.equal(await old.configure(7180), null); assert.equal(f.writes.length, before);
  const current = f.manager(); await current.configure(8180);
  old.retire(); assert.equal(current.requestsBlocked, false);
  assert.deepEqual(await f.request(), { cancel: false });
});

test('a failed replacement stays fail closed and the previous owner cannot restore its PAC', async () => {
  const f = fixture(), old = f.manager(); await old.configure(6180);
  const failure = new Error('synthetic replacement policy failure');
  const current = f.manager({ routingPolicy: { proxyConfig: async () => { throw failure; } } });
  await assert.rejects(current.configure(8180), error => error === failure);
  const writes = f.writes.length;
  assert.equal(current.requestsBlocked, true); assert.deepEqual(await f.request(), { cancel: true });
  assert.equal(await old.resume(6180), null); assert.equal(f.writes.length, writes);
});

test('distinct native Sessions never retire or block each other', async () => {
  const first = fixture(), second = fixture(), a = first.manager(), b = second.manager();
  await a.configure(6180); await b.configure(8180); a.retire();
  assert.equal(a.requestsBlocked, true); assert.equal(b.requestsBlocked, false);
  assert.deepEqual(await second.request(), { cancel: false });
});
