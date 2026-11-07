'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MyPortalDataRuntime } = require('../../../lib/browser/session/browser-session-manager');
const { BrowserRequestSecurityBoundary } = require('../../../lib/browser/certificates/certificate-controller');
const { EphemeralProxyCredential } = require('../../../lib/persistence/credentials/proxy-credential');

function fixture() {
  const f = { generation: 7, partition: 'persist:portal-proxy-first', portal: 'https://portal.example.edu/', requests: [], captures: 0, throwOnAnswer: false };
  f.credential = new EphemeralProxyCredential();
  assert.equal(f.credential.bindGeneration(7, 21334), true);
  const boundary = new BrowserRequestSecurityBoundary({ getBrowser: () => ({ ownsWebContents: () => false }),
    getEngineGeneration: () => f.generation, proxyAccess: f.credential });
  f.boundary = boundary;
  f.authInfo = { isProxy: true, scheme: 'basic', host: '127.0.0.1', port: 21334 };
  f.runtime = new MyPortalDataRuntime({
    electronSession: { fromPartition: () => ({}) },
    electronNet: { request() {
      const request = new EventEmitter();
      Object.assign(request, { setHeader() {}, end() {}, abort() { request.emit('error', new Error('synthetic transport cancellation')); } });
      f.requests.push(request); return request;
    } },
    getPartition: () => f.partition, getPortalUrl: () => f.portal, timeoutMs: 500,
    getProxyLogin: () => {
      f.captures++;
      const answer = boundary.captureProxyLogin();
      return (info, callback) => { if (f.throwOnAnswer) throw new Error('synthetic private failure'); return answer(info, callback); };
    },
  });
  f.begin = () => f.runtime.snapshot({ force: true }).then(value => ({ value }), error => ({ error }));
  f.challenge = info => {
    const observed = { calls: 0, credentials: false };
    f.requests.at(-1).emit('login', info || f.authInfo, (...values) => {
      observed.calls++;
      observed.credentials = values.length === 2;
      if (values.length === 2) {
        const expected = f.credential.socksAuthentication(7);
        assert.equal(values[0] === expected?.username.toString('ascii'), true);
        assert.equal(values[1] === expected?.password.toString('ascii'), true);
      }
    });
    return observed;
  };
  f.complete = () => {
    const response = new EventEmitter(); Object.assign(response, { statusCode: 200, headers: { 'content-type': ['text/html'] } });
    f.requests.at(-1).emit('response', response);
    response.emit('data', Buffer.from('<title>Synthetic portal</title>')); response.emit('end');
  };
  return f;
}

test('an admitted cold portal probe can answer through the existing generation-bound owner', async t => {
  const f = fixture(); t.after(() => f.credential.destroy());
  const pending = f.begin();
  assert.deepEqual(f.challenge(), { calls: 1, credentials: true });
  f.complete();
  assert.equal((await pending).value.sessionState, 'authenticated');
  assert.equal(f.captures, 1);
});

for (const [name, info] of [
  ['foreign host', { host: 'proxy.example.edu' }], ['different loopback name', { host: 'localhost' }],
  ['wrong port', { port: 21335 }], ['unsupported scheme', { scheme: 'digest' }],
  ['origin authentication', { isProxy: false }],
]) {
  test(`portal request refuses ${name} without sending credentials`, async t => {
    const f = fixture(); t.after(() => f.credential.destroy()); const pending = f.begin();
    assert.deepEqual(f.challenge({ ...f.authInfo, ...info }), { calls: 1, credentials: false });
    const result = await pending;
    assert.equal(result.value.sessionState, info.isProxy === false ? 'unauthenticated' : 'unknown');
  });
}

for (const [name, retire, contextError] of [
  ['Engine generation replaced', f => { f.generation++; }, false],
  ['credential revoked', f => f.credential.destroy(), false],
  ['partition changed', f => { f.partition = 'persist:portal-proxy-next'; }, true],
  ['portal changed', f => { f.portal = 'https://other.example.edu/'; }, true],
  ['portal removed', f => { f.portal = null; }, true],
  ['display context invalidated', f => f.runtime.invalidate(), true],
  ['capability threw', f => { f.throwOnAnswer = true; }, false],
]) {
  test(`portal challenge is cancelled after ${name}`, async t => {
    const f = fixture(); t.after(() => f.credential.destroy()); const pending = f.begin(); retire(f);
    assert.deepEqual(f.challenge(), { calls: 1, credentials: false });
    const result = await pending;
    if (contextError) assert.equal(result.error?.code, 'PORTAL_CONTEXT_CHANGED');
    else assert.equal(result.value.sessionState, 'unknown');
  });
}

test('completed requests cancel a late challenge without borrowing credentials or changing the snapshot', async t => {
  const f = fixture(); t.after(() => f.credential.destroy()); const pending = f.begin();
  f.complete(); const result = await pending;
  assert.equal(result.value.sessionState, 'authenticated');
  assert.deepEqual(f.challenge(), { calls: 1, credentials: false });
  assert.equal(f.runtime.cached, result.value);
});

test('source timeout cancels late login without answering or leaving an unhandled emitter error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.credential.destroy()); const pending = f.begin();
  t.mock.timers.tick(500); assert.equal((await pending).value.sessionState, 'unknown');
  assert.deepEqual(f.challenge(), { calls: 1, credentials: false });
});

test('request capability does not relax the app.login WebContents ownership boundary', t => {
  const f = fixture(); t.after(() => f.credential.destroy()); let callbacks = 0;
  f.boundary.proxyLogin({ preventDefault() { throw new Error('unowned event was handled'); } }, {}, {}, f.authInfo, () => callbacks++);
  assert.equal(callbacks, 0);
});
