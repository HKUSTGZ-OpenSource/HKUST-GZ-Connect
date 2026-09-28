'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CampusCertificateTrustStore,
  CertificateController,
  certificateTime,
} = require('../../../../lib/browser/certificates/certificate-controller');
const { certificateFingerprint } = require('../../../../lib/browser/certificates/campus-certificate-trust');
const { createT } = require('../../../../lib/platform/i18n/i18n');

test('public certificate entrypoint re-exports the existing store without another implementation', () => {
  const implementation = require('../../../../lib/browser/certificates/campus-certificate-trust');
  assert.equal(CampusCertificateTrustStore, implementation.CampusCertificateTrustStore);
  assert.equal(typeof CampusCertificateTrustStore, 'function');
});

const CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  Buffer.from('fixture-certificate-der').toString('base64'),
  '-----END CERTIFICATE-----',
].join('\n');
const ALTERED_CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  Buffer.from('altered-fixture-certificate-der').toString('base64'),
  '-----END CERTIFICATE-----',
].join('\n');

function fixture(overrides = {}) {
  const pins = new Map();
  const prompts = [];
  const trusts = [];
  const trustStore = overrides.trustStore || {
    isTrusted(origin, fingerprint) { return pins.get(origin) === fingerprint; },
    async trust(origin, fingerprint) {
      trusts.push([origin, fingerprint]);
      pins.set(origin, fingerprint);
    },
  };
  const dialog = overrides.dialog || {
    async showMessageBox(parent, options) {
      prompts.push({ parent, options });
      return { response: 0 };
    },
  };
  const parent = overrides.parent === undefined
    ? { isDestroyed: () => false }
    : overrides.parent;
  const controller = new CertificateController({
    trustStore,
    dialog,
    windowForPrompt: () => parent,
    locale: () => overrides.locale || 'zh',
    t: createT(overrides.locale || 'zh'),
  });
  return { controller, dialog, pins, prompts, trusts, trustStore };
}

function request(overrides = {}) {
  return {
    url: 'https://103.189.154.10:4433/login',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    certificate: {
      data: CERTIFICATE_PEM,
      subjectName: '103.189.154.10',
      issuerName: 'HKUST(GZ) test gateway',
      validStart: 1_700_000_000,
      validExpiry: 1_800_000_000,
    },
    ...overrides,
  };
}

test('one confirmed prompt trusts only the exact origin and fingerprint', async () => {
  const state = fixture();
  let callbacks = 0;
  const allowed = await state.controller.handle(request({
    callback(value) {
      callbacks++;
      assert.equal(value, true);
      throw new Error('callback failures must not escape');
    },
  }));
  const fingerprint = certificateFingerprint(CERTIFICATE_PEM);
  assert.equal(allowed, true);
  assert.equal(callbacks, 1);
  assert.deepEqual(state.trusts, [[
    'https://103.189.154.10:4433', fingerprint,
  ]]);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.prompts[0].options.defaultId, 1, 'trust must not be the default action');
  assert.equal(state.prompts[0].options.cancelId, 1);
  assert.match(state.prompts[0].options.detail, /SHA-256/);
  assert.match(state.prompts[0].options.detail, /ERR_CERT_AUTHORITY_INVALID/);
  assert.match(state.prompts[0].options.detail, /HKUST\(GZ\) test gateway/);
  assert.equal(state.controller.decisions.size, 0);

  let trustedCallback = 0;
  assert.equal(await state.controller.handle(request({
    url: 'https://103.189.154.10:4433/again',
    callback(value) { trustedCallback++; assert.equal(value, true); },
  })), true);
  assert.equal(trustedCallback, 1);
  assert.equal(state.prompts.length, 1, 'an exact trusted pin must bypass the prompt');

  state.dialog.showMessageBox = async () => ({ response: 1 });
  assert.equal(await state.controller.handle(request({
    url: 'https://103.189.154.10:4443/login',
  })), false, 'a different port is a different origin');
});

test('same-origin same-fingerprint requests share one prompt and trust write', async () => {
  let resolvePrompt;
  let promptCount = 0;
  let trustCount = 0;
  const prompt = new Promise((resolve) => { resolvePrompt = resolve; });
  const state = fixture({
    dialog: { showMessageBox: async () => { promptCount++; return prompt; } },
    trustStore: {
      isTrusted: () => false,
      trust: async () => { trustCount++; },
    },
  });
  const callbacks = [];
  const first = state.controller.handle(request({ callback: (value) => callbacks.push(['a', value]) }));
  const second = state.controller.handle(request({ callback: (value) => callbacks.push(['b', value]) }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 1);
  assert.equal(state.controller.decisions.size, 1);
  resolvePrompt({ response: 0 });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(callbacks.sort(), [['a', true], ['b', true]]);
  assert.equal(trustCount, 1);
  assert.equal(state.controller.decisions.size, 0);
});

test('a different fingerprint racing on one origin is denied without a second prompt', async () => {
  const alteredFingerprint = certificateFingerprint(ALTERED_CERTIFICATE_PEM);
  let resolvePrompt;
  let promptCount = 0;
  const prompt = new Promise((resolve) => { resolvePrompt = resolve; });
  const state = fixture({
    dialog: { showMessageBox: async () => { promptCount++; return prompt; } },
    trustStore: {
      // Even an older trusted pin cannot bypass an in-progress changed-cert
      // decision for the same origin.
      isTrusted: (_origin, fingerprint) => fingerprint === alteredFingerprint,
      trust: async () => {},
    },
  });
  const callbacks = [];
  const first = state.controller.handle(request({ callback: (value) => callbacks.push(['first', value]) }));
  const changed = state.controller.handle(request({
    certificate: { data: ALTERED_CERTIFICATE_PEM },
    callback: (value) => callbacks.push(['changed', value]),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 1);
  resolvePrompt({ response: 0 });
  assert.deepEqual(await Promise.all([first, changed]), [true, false]);
  assert.deepEqual(callbacks.sort(), [['changed', false], ['first', true]]);
  assert.equal(promptCount, 1);
  assert.equal(state.controller.decisions.size, 0);
});

test('different untrusted origins cannot stack native certificate prompts', async () => {
  let resolvePrompt;
  let promptCount = 0;
  const prompt = new Promise((resolve) => { resolvePrompt = resolve; });
  const state = fixture({
    dialog: { showMessageBox: async () => { promptCount++; return prompt; } },
    trustStore: { isTrusted: () => false, trust: async () => {} },
  });
  const callbacks = [];
  const first = state.controller.handle(request({
    url: 'https://first.invalid/',
    callback: (value) => callbacks.push(['first', value]),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    state.controller.handle(request({
      url: `https://cert-${index}.attacker.invalid/`,
      callback: (value) => callbacks.push([`other-${index}`, value]),
    }))));
  assert.deepEqual(new Set(rejected), new Set([false]));
  assert.equal(promptCount, 1);
  assert.equal(state.controller.decisions.size, 1);
  resolvePrompt({ response: 1 });
  assert.equal(await first, false);
  assert.equal(callbacks.length, 33);
  assert.equal(callbacks.every(([, allowed]) => allowed === false), true);
  assert.equal(state.controller.decisions.size, 0);
  assert.equal(state.controller.activePrompt, null);
});

test('cancelling browser lifecycle denies pending certificate callbacks and prevents trust', async () => {
  let resolvePrompt;
  let trustCount = 0;
  const prompt = new Promise((resolve) => { resolvePrompt = resolve; });
  const state = fixture({
    dialog: { showMessageBox: async () => prompt },
    trustStore: {
      isTrusted: () => false,
      trust: async () => { trustCount++; },
    },
  });
  const callbacks = [];
  const pending = state.controller.handle(request({
    callback: (value) => callbacks.push(value),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  state.controller.cancelAll();
  assert.equal(await pending, false);
  assert.deepEqual(callbacks, [false]);
  resolvePrompt({ response: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(trustCount, 0);
  assert.equal(state.controller.decisions.size, 0);
  assert.equal(state.controller.activePrompt, null);
});

test('cancel, malformed inputs, and trust failures fail closed with one callback', async () => {
  for (const invalid of [
    request({ url: 'http://example.edu/login' }),
    request({ url: 'https://user:pass@example.edu/login' }),
    request({ certificate: { data: 'not a certificate' } }),
  ]) {
    const state = fixture();
    const decisions = [];
    assert.equal(await state.controller.handle({
      ...invalid, callback: (value) => decisions.push(value),
    }), false);
    assert.deepEqual(decisions, [false]);
    assert.equal(state.prompts.length, 0);
  }

  const cancelled = fixture({
    dialog: { showMessageBox: async () => ({ response: 1 }) },
  });
  let cancelCallbacks = 0;
  assert.equal(await cancelled.controller.handle(request({
    callback(value) { cancelCallbacks++; assert.equal(value, false); },
  })), false);
  assert.equal(cancelCallbacks, 1);

  const failedTrust = fixture({
    trustStore: {
      isTrusted: () => false,
      trust: async () => { throw new Error('disk unavailable'); },
    },
  });
  let failureCallbacks = 0;
  assert.equal(await failedTrust.controller.handle(request({
    callback(value) { failureCallbacks++; assert.equal(value, false); },
  })), false);
  assert.equal(failureCallbacks, 1);
  assert.equal(failedTrust.controller.decisions.size, 0);
});

test('certificate timestamps are locale-aware and reject invalid values', () => {
  const zh = createT('zh');
  const en = createT('en');
  assert.match(certificateTime(1_700_000_000, 'en', en), /2023/);
  assert.match(certificateTime(1_700_000_000, 'zh', zh), /2023/);
  assert.equal(certificateTime(0, 'en', en), en('cert.unknown'));
});

test('CampusBrowser delegates certificate policy and retains only ownership wiring', () => {
  const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const source = fs.readFileSync(
    path.join(desktopRoot, 'lib', 'browser', 'session', 'campus-browser.js'),
    'utf8',
  );
  assert.match(source, /this\.certificateController\s*=\s*new CertificateController\(\{/);
  assert.match(source, /handleCertificateError\(request\)\s*\{[\s\S]{0,120}this\.certificateController\.handle\(request\)/);
  assert.match(source, /ownsWebContents\(webContents\)/);
  assert.doesNotMatch(source, /certificateFingerprint\(/);
  assert.doesNotMatch(source, /normalizeCertificateOrigin\(/);
  assert.doesNotMatch(source, /this\.certificateDecisions\.set\(/);
});
