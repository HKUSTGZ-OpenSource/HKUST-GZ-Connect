'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { portalSessionTransport, readPortalResponseWithinDeadline } = require('../../../../lib/browser/session/myportal-catalog');
const portal = 'https://myportal.hkust-gz.edu.cn/';

function fixture() {
  const request = new EventEmitter();
  const response = new EventEmitter();
  const owner = {};
  let options, aborts = 0, follows = 0;
  Object.assign(request, {
    setHeader() {}, end() {}, followRedirect() { follows++; },
    abort() { aborts++; request.emit('error', new Error('synthetic private transport detail')); },
  });
  Object.assign(response, { statusCode: 200, headers: { 'content-type': ['application/json'] } });
  const transport = portalSessionTransport({ request: value => { options = value; return request; } }, owner, portal);
  const controller = new AbortController();
  const operation = () => transport.fetch(`${portal}data`, { signal: controller.signal });
  const complete = body => { request.emit('response', response); response.emit('data', Buffer.from(body)); response.emit('end'); };
  return { request, response, owner, controller, transport, operation, complete,
    options: () => options, aborts: () => aborts, follows: () => follows };
}

test('native request uses the selected Session, bounds redirects and does not trust fetch URL metadata', async () => {
  const f = fixture(); const pending = f.operation();
  assert.equal(f.options().session, f.owner);
  assert.equal(f.options().credentials, 'include');
  assert.equal(f.options().redirect, 'manual');
  assert.equal(f.options().cache, 'no-store');
  f.request.emit('close'); // Writable close can precede response in Electron.
  f.request.emit('redirect', 302, 'GET', `${portal}api`);
  assert.equal(f.follows(), 1); f.complete('[]');
  const result = await pending;
  assert.equal(result.url, `${portal}api`); assert.equal(await result.text(), '[]');
  f.controller.abort(); assert.equal(f.aborts(), 0, 'completed request releases abort subscription');
});

test('native auth redirects settle once without requesting or buffering sign-in content', async () => {
  for (const target of [`${portal}Account/Login`, 'https://sso.hkust-gz.edu.cn/connect/authorize']) {
    const f = fixture(); const pending = assert.rejects(f.operation(), { code: 'PORTAL_SESSION_EXPIRED' });
    f.request.emit('redirect', 302, 'GET', target);
    await pending; assert.equal(f.follows(), 0); assert.equal(f.aborts(), 1);
    f.controller.abort(); f.request.emit('error', new Error('late private detail'));
    assert.equal(f.aborts(), 1);
  }
});

test('unknown, insecure, credential-bearing and looping redirects fail closed without inventing expiry', async () => {
  for (const target of ['https://unknown.example/Account/Login', 'http://myportal.hkust-gz.edu.cn/api',
    'file:///synthetic', 'https://synthetic@myportal.hkust-gz.edu.cn/api', `${portal}loop`]) {
    const f = fixture(); const pending = assert.rejects(f.operation(), { code: 'PORTAL_RESPONSE_INVALID' });
    for (let i = 0; i < 6; i++) f.request.emit('redirect', 302, 'GET', target);
    await pending; assert.ok(f.follows() <= 5); assert.equal(f.aborts(), 1);
  }
});

test('native transport rejects oversized streams, aborted bodies and private error text', async () => {
  for (const mode of ['length', 'stream', 'aborted', 'error']) {
    const f = fixture(); const pending = assert.rejects(f.operation(), error => {
      assert.ok(['PORTAL_RESPONSE_INVALID', 'PORTAL_REQUEST_FAILED'].includes(error.code));
      assert.doesNotMatch(error.message, /private detail/); return true;
    });
    if (mode === 'length') f.response.headers['content-length'] = ['524289'];
    f.request.emit('response', f.response);
    if (mode === 'stream') f.response.emit('data', Buffer.alloc(524289));
    if (mode === 'aborted') f.response.emit('aborted');
    if (mode === 'error') f.response.emit('error', new Error('private detail'));
    await pending; assert.equal(f.aborts(), 1);
  }
});

test('native body stalls still terminate within the existing source deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const context = { session: f.transport, portalUrl: portal, timeoutMs: 500 };
  const pending = assert.rejects(readPortalResponseWithinDeadline(context, new URL(`${portal}data`),
    async response => response.text()), { code: 'PORTAL_SOURCE_TIMEOUT' });
  f.request.emit('response', f.response);
  f.response.emit('data', Buffer.from('['));
  t.mock.timers.tick(500); await pending; assert.equal(f.aborts(), 1);
});

test('401 and 403 preserve distinct status without consuming error bodies', async () => {
  for (const status of [401, 403]) {
    const f = fixture(); const pending = f.operation();
    f.response.statusCode = status; f.request.emit('response', f.response);
    const result = await pending;
    assert.equal(result.status, status); assert.equal(await result.text(), '');
    assert.equal(f.response.listenerCount('data'), 0); assert.equal(f.aborts(), 1);
  }
});
