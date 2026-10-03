'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { CampusBrowserManager } = require('../../../../lib/browser/session/campus-browser-manager');
const { CampusCertificateTrustStore } = require('../../../../lib/browser/certificates/certificate-controller');

function fixture() {
  const calls = [];
  const state = { generation: 12, owned: true, matches: true, currentBrowser: null };
  const browser = {
    ownsWebContents: contents => { calls.push(['owns', contents]); return state.owned; },
    handleCertificateError: request => { calls.push(['certificate', request]); request.callback(true); },
  };
  state.currentBrowser = browser;
  const boundary = CampusBrowserManager.createRequestSecurityBoundary({
    getBrowser: () => state.currentBrowser,
    getEngineGeneration: () => state.generation,
    proxyAccess: {
      matchesProxyChallenge: (info, generation) => {
        calls.push(['match', info, generation]); return state.matches;
      },
      answerProxyChallenge: (info, generation, callback) => {
        calls.push(['answer', info, generation, callback]); return true;
      },
    },
  });
  return { boundary, state, calls, browser };
}

test('public request-security factory validates capabilities without invoking them', () => {
  assert.throws(() => CampusBrowserManager.createRequestSecurityBoundary({}), TypeError);
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.equal(typeof f.boundary.certificateError, 'function');
  assert.equal(typeof f.boundary.proxyLogin, 'function');
});

test('unowned certificate errors retain Chromium defaults without prompting or answering', () => {
  const f = fixture();
  f.state.owned = false;
  let prevented = false;
  let answered = false;
  f.boundary.certificateError({ preventDefault() { prevented = true; } }, {},
    'https://fixture.invalid', 'synthetic-error', {}, () => { answered = true; }, true);
  assert.equal(prevented, false);
  assert.equal(answered, false);
  assert.equal(f.calls.some(call => call[0] === 'certificate'), false);
});

test('owned subresource and unknown-frame certificate errors reject without consent', () => {
  for (const frame of [false, undefined, null, 'true']) {
    const f = fixture();
    let prevented = 0;
    const answers = [];
    f.boundary.certificateError({ preventDefault() { prevented++; } }, {},
      'https://fixture.invalid', 'synthetic-error', {}, result => answers.push(result), frame);
    assert.equal(prevented, 1);
    assert.deepEqual(answers, [false]);
    assert.equal(f.calls.some(call => call[0] === 'certificate'), false);
  }
});

test('only owned main frames forward exact request and callback to the existing consent owner', async () => {
  const f = fixture();
  const contents = {};
  const certificate = {};
  const answers = [];
  const callback = allowed => answers.push(allowed);
  let prevented = 0;
  const handler = f.boundary.certificateError;
  handler({ preventDefault() { prevented++; } }, contents, 'https://fixture.invalid',
    'synthetic-error', certificate, callback, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 1);
  assert.deepEqual(f.calls, [['owns', contents], ['certificate', {
    url: 'https://fixture.invalid', error: 'synthetic-error', certificate, callback,
  }]]);
  assert.deepEqual(answers, [true]);
});

test('a failed Browser consent owner preserves the existing fail-closed callback behavior', async () => {
  const f = fixture();
  f.browser.handleCertificateError = async () => { throw new Error('synthetic consent failure'); };
  const answers = [];
  f.boundary.certificateError({ preventDefault() {} }, {}, 'https://fixture.invalid',
    'synthetic-error', {}, result => answers.push(result), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(answers, [false]);
});

test('unowned proxy challenges never query or borrow proxy credentials', () => {
  const f = fixture();
  f.state.owned = false;
  f.boundary.proxyLogin({ preventDefault() { assert.fail('must remain Chromium-owned'); } }, {},
    {}, {}, () => assert.fail('must not receive a credential'));
  assert.deepEqual(f.calls.map(call => call[0]), ['owns']);
});

test('nonmatching challenge retains defaults and matching challenge uses one captured generation', () => {
  const f = fixture();
  const contents = {};
  const info = { synthetic: true };
  const callback = () => {};
  f.state.matches = false;
  let prevented = 0;
  f.boundary.proxyLogin({ preventDefault() { prevented++; } }, contents, {}, info, callback);
  assert.equal(prevented, 0);
  assert.deepEqual(f.calls, [['owns', contents], ['match', info, 12]]);
  f.calls.length = 0;
  f.state.matches = true;
  f.state.generation = 13;
  const handler = f.boundary.proxyLogin;
  handler({ preventDefault() { prevented++; f.state.generation = 14; } }, contents, {}, info, callback);
  assert.equal(prevented, 1);
  assert.deepEqual(f.calls, [['owns', contents], ['match', info, 13], ['answer', info, 13, callback]]);
});

test('handler invocation resolves the current Browser rather than a stale construction snapshot', () => {
  const f = fixture();
  f.state.currentBrowser = { ownsWebContents: () => false };
  f.boundary.proxyLogin({ preventDefault() { assert.fail('unowned'); } }, {}, {}, {}, () => {});
  assert.deepEqual(f.calls, []);
});

test('public certificate-store factory preserves the existing store and defers file access', () => {
  const store = CampusBrowserManager.createCertificateTrustStore({ filePath: '/synthetic/no-such/trust.json' });
  assert.ok(store instanceof CampusCertificateTrustStore);
  assert.equal(store.filePath, '/synthetic/no-such/trust.json');
  assert.equal(fs.existsSync(store.filePath), false);
});
