'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createAuthChallengeFeature } = require('../renderer/auth-challenge');
const I18N = require('../renderer/i18n');

const IDS = [
  'authChallengeDialog',
  'authChallengeForm',
  'authChallengeDescription',
  'authChallengeDestination',
  'authChallengeAttempts',
  'authChallengeResponseField',
  'authChallengeResponse',
  'authChallengeError',
  'authChallengeResend',
  'authChallengeCancel',
  'authChallengeSubmit',
];

class FakeElement {
  constructor() {
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.open = false;
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) {
    this.listeners.get(type)?.({ preventDefault() {} });
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

function fixture(api = {}) {
  const elements = new Map(IDS.map((id) => [id, new FakeElement()]));
  const document = {
    documentElement: { lang: 'en' },
    getElementById: (id) => elements.get(id),
  };
  const feature = createAuthChallengeFeature({
    api: {
      respondAuthChallenge: async () => ({ ok: true }),
      resendAuthChallenge: async () => ({ ok: true }),
      cancelAuthChallenge: async () => ({ ok: true }),
      ...api,
    },
    document,
    i18n: I18N,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
  });
  return { elements, feature };
}

const VIEW = Object.freeze({
  kind: 'otp',
  deliveryChannel: 'email',
  maskedDestination: 's***@example.test',
  expiresAtUnixMs: null,
  resendAvailable: true,
  resendAfterUnixMs: null,
  attemptsRemaining: 3,
});

test('renderer clears the DOM response before invoking Main and never restores failures', async () => {
  let captured;
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { elements, feature } = fixture({
    respondAuthChallenge: (response) => { captured = response; return pending; },
  });
  feature.render(VIEW);
  const input = elements.get('authChallengeResponse');
  input.value = 'synthetic-response';
  elements.get('authChallengeForm').dispatch('submit');
  assert.equal(captured, 'synthetic-response');
  assert.equal(input.value, '');
  assert.equal(elements.get('authChallengeSubmit').disabled, true);
  resolve({ ok: false, code: 'provider_failure' });
  await new Promise((done) => setImmediate(done));
  assert.equal(input.value, '');
  assert.match(elements.get('authChallengeError').textContent, /re-enter/i);
});

test('unknown challenge is fail-closed and cancel clears any response', async () => {
  let responded = false;
  let cancelled = false;
  const { elements, feature } = fixture({
    respondAuthChallenge: async () => { responded = true; return { ok: true }; },
    cancelAuthChallenge: async () => { cancelled = true; return { ok: true }; },
  });
  feature.render({ ...VIEW, kind: 'unknown' });
  assert.equal(elements.get('authChallengeResponseField').hidden, true);
  assert.equal(elements.get('authChallengeSubmit').disabled, true);
  assert.equal(elements.get('authChallengeResend').disabled, true);
  elements.get('authChallengeResponse').value = 'must-clear';
  elements.get('authChallengeForm').dispatch('submit');
  assert.equal(responded, false);
  elements.get('authChallengeCancel').dispatch('click');
  assert.equal(elements.get('authChallengeResponse').value, '');
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, true);
});

test('markup provides one-time-code semantics without assuming numeric shape or clipboard access', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'auth-challenge.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features/auth-challenge/controller.mjs'), 'utf8');
  assert.match(html, /id="authChallengeResponse"[\s\S]*autocomplete="one-time-code"/);
  assert.doesNotMatch(html, /authChallengeResponse[^>]*inputmode="numeric"/);
  assert.doesNotMatch(source, /clipboard|writeText|localStorage|sessionStorage/);
});
