'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSpaCredentialMonitor,
  credentialFromForm,
  isAuthenticationChallengeForm,
  isChallengeInput,
  isPasswordChangeForm,
  loginPasswordInput,
  pageHasAuthenticationChallenge,
  pageCredentialState,
  SPA_CREDENTIAL_SETTLE_MS,
} = require('../../../../campus-preload');

function input(properties = {}) {
  return {
    autocomplete: '',
    ariaLabel: '',
    disabled: false,
    id: '',
    name: '',
    placeholder: '',
    inputMode: '',
    type: 'text',
    value: '',
    ...properties,
  };
}

function form(inputs, properties = {}) {
  return {
    action: '',
    ariaLabel: '',
    className: '',
    id: '',
    name: '',
    textContent: '',
    ...properties,
    querySelectorAll(selector) {
      if (selector === 'input[type="password"]') {
        return inputs.filter((candidate) => candidate.type === 'password');
      }
      if (selector === 'input') return inputs;
      return [];
    },
  };
}

const HTTPS_LOCATION = {
  protocol: 'https:',
  origin: 'https://sso.example.edu',
};

test('login credential candidate is exact-origin HTTPS data', () => {
  const login = form([
    input({ name: 'account', autocomplete: 'username', value: 'student001' }),
    input({ name: 'password', type: 'password', autocomplete: 'current-password', value: 'secret' }),
  ]);
  assert.deepEqual(credentialFromForm(login, HTTPS_LOCATION), {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'secret',
  });
  assert.equal(credentialFromForm(login, { protocol: 'http:', origin: 'http://sso.example.edu' }), null);
});

test('traditional and explicit password-only login evidence remains compatible', () => {
  const traditional = form([
    input({ name: 'account', value: 'student001' }),
    input({ name: 'password', type: 'password', value: 'secret' }),
  ]);
  assert.deepEqual(credentialFromForm(traditional, HTTPS_LOCATION), {
    origin: HTTPS_LOCATION.origin,
    username: 'student001',
    password: 'secret',
  });

  const passwordOnly = form([
    input({ type: 'password', autocomplete: 'current-password', value: 'secret' }),
  ]);
  assert.deepEqual(credentialFromForm(passwordOnly, HTTPS_LOCATION), {
    origin: HTTPS_LOCATION.origin,
    username: '',
    password: 'secret',
  });
});

test('ambiguous single-secret fields are rejected before their values are read', () => {
  for (const ambiguous of [
    input({ type: 'password' }),
    input({ type: 'password', inputMode: 'numeric' }),
  ]) {
    Object.defineProperty(ambiguous, 'value', {
      configurable: true,
      get() { throw new Error('ambiguous secret values must never be read'); },
    });
    const ambiguousForm = form([ambiguous]);
    assert.equal(loginPasswordInput(ambiguousForm), null);
    assert.equal(credentialFromForm(ambiguousForm, HTTPS_LOCATION), null);
  }

  const unlabeledTextIsNotUsernameEvidence = form([
    input({ value: 'not-explicitly-a-username' }),
    input({ type: 'password', value: 'ambiguous-secret' }),
  ]);
  assert.equal(credentialFromForm(unlabeledTextIsNotUsernameEvidence, HTTPS_LOCATION), null);
});

test('password change and reset forms never become login candidates', () => {
  const change = form([
    input({ type: 'password', autocomplete: 'current-password', value: 'old-secret' }),
    input({ type: 'password', autocomplete: 'new-password', value: 'new-secret' }),
    input({ type: 'password', name: 'confirm_password', value: 'new-secret' }),
  ]);
  const reset = form([
    input({ type: 'password', name: 'new_password', value: 'new-secret' }),
  ]);
  const actionOnly = form([
    input({ type: 'password', name: 'password', value: 'new-secret' }),
  ], { action: 'https://sso.example.edu/account/change-password' });
  assert.equal(isPasswordChangeForm(change), true);
  assert.equal(isPasswordChangeForm(reset), true);
  assert.equal(isPasswordChangeForm(actionOnly), true);
  assert.equal(credentialFromForm(change, HTTPS_LOCATION), null);
  assert.equal(credentialFromForm(reset, HTTPS_LOCATION), null);
  assert.equal(credentialFromForm(actionOnly, HTTPS_LOCATION), null);
});

test('generic OTP and MFA fields never become password candidates or autofill targets', () => {
  const oneTimeCode = input({
    autocomplete: 'one-time-code',
    inputMode: 'numeric',
    name: 'otp',
    type: 'text',
  });
  const passwordShapedOtp = input({
    ariaLabel: 'Verification code',
    name: 'verificationCode',
    type: 'password',
  });
  const pushChallenge = form([], { textContent: 'Approve sign-in on your device' });
  const codeForm = form([oneTimeCode]);
  const passwordCodeForm = form([passwordShapedOtp]);

  assert.equal(isChallengeInput(oneTimeCode), true);
  assert.equal(isChallengeInput(passwordShapedOtp), true);
  assert.equal(isAuthenticationChallengeForm(codeForm), true);
  assert.equal(isAuthenticationChallengeForm(passwordCodeForm), true);
  assert.equal(isAuthenticationChallengeForm(pushChallenge), true);
  assert.equal(loginPasswordInput(passwordCodeForm, { requireValue: false }), null);
  assert.equal(credentialFromForm(passwordCodeForm, HTTPS_LOCATION), null);

  assert.equal(isChallengeInput(input({ name: 'code' })), true);
  assert.equal(isChallengeInput(input({ name: 'studentCode', autocomplete: 'username' })), false,
    'a username identifier containing code is not automatically an OTP');

  Object.defineProperty(passwordShapedOtp, 'value', {
    configurable: true,
    get() { throw new Error('OTP values must never be read'); },
  });
  assert.equal(credentialFromForm(passwordCodeForm, HTTPS_LOCATION), null);
});

test('page context catches an unlabelled password-shaped challenge without blocking normal login', () => {
  const unlabelled = form([input({ type: 'password' })]);
  const challengeDocument = {
    title: 'Two-factor verification',
    body: { innerText: 'Enter the security code from your device' },
    forms: [unlabelled],
  };
  assert.equal(isAuthenticationChallengeForm(unlabelled, challengeDocument), true);
  assert.equal(pageHasAuthenticationChallenge(challengeDocument), true);
  assert.equal(loginPasswordInput(unlabelled, {
    requireValue: false,
    pageDocument: challengeDocument,
  }), null);

  const normalLogin = form([
    input({ autocomplete: 'username' }),
    input({ type: 'password', autocomplete: 'current-password' }),
  ]);
  assert.ok(loginPasswordInput(normalLogin, {
    requireValue: false,
    pageDocument: challengeDocument,
  }), 'a username/password form remains an ordinary login surface');
});

test('page state reports whether the post-navigation document still has a login form', () => {
  const login = form([input({ type: 'password', autocomplete: 'current-password' })]);
  assert.deepEqual(pageCredentialState({ forms: [login] }, HTTPS_LOCATION), {
    origin: HTTPS_LOCATION.origin,
    hasLoginForm: true,
    hasChallengeForm: false,
  });
  const passwordReset = form([
    input({ type: 'password', autocomplete: 'new-password' }),
  ]);
  assert.deepEqual(pageCredentialState({ forms: [passwordReset] }, HTTPS_LOCATION), {
    origin: HTTPS_LOCATION.origin,
    hasLoginForm: true,
    hasChallengeForm: false,
  });
  assert.deepEqual(pageCredentialState({ forms: [] }, HTTPS_LOCATION), {
    origin: HTTPS_LOCATION.origin,
    hasLoginForm: false,
    hasChallengeForm: false,
  });
  const challenge = form([
    input({ type: 'password', autocomplete: 'one-time-code' }),
  ]);
  assert.deepEqual(pageCredentialState({ forms: [challenge] }, HTTPS_LOCATION), {
    origin: HTTPS_LOCATION.origin,
    hasLoginForm: false,
    hasChallengeForm: true,
  });
  assert.equal(pageCredentialState({ forms: [] }, { protocol: 'http:', origin: 'http://x' }), null);
});

test('SPA login waits for a stable same-origin password-form removal', () => {
  const login = form([
    input({ autocomplete: 'username', value: 'student001' }),
    input({ type: 'password', autocomplete: 'current-password', value: 'secret' }),
  ]);
  const pageDocument = { documentElement: {}, forms: [login] };
  const timers = [];
  const cleared = [];
  const states = [];
  let observerCallback = null;
  let disconnected = false;
  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe(_target, options) { this.options = options; }
    disconnect() { disconnected = true; }
  }
  const monitor = createSpaCredentialMonitor({
    pageDocument,
    pageLocation: HTTPS_LOCATION,
    onState: (state) => states.push(state),
    MutationObserverClass: FakeMutationObserver,
    setTimer: (callback, delay) => {
      const handle = { callback, delay, unref() { this.unrefCalled = true; } };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => cleared.push(handle),
  });

  assert.equal(monitor.arm(HTTPS_LOCATION.origin), true);
  assert.equal(timers.length, 0, 'the submitted login form still blocks confirmation');
  const challenge = form([input({ autocomplete: 'one-time-code', name: 'otp' })]);
  pageDocument.forms = [challenge];
  observerCallback();
  assert.equal(timers.length, 0, 'a second-factor form is not post-login evidence');
  pageDocument.forms = [];
  observerCallback();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, SPA_CREDENTIAL_SETTLE_MS);
  assert.equal(timers[0].unrefCalled, true);

  pageDocument.forms = [login];
  observerCallback();
  assert.deepEqual(cleared, [timers[0]], 'a returning password form cancels the candidate state');
  assert.deepEqual(states, []);

  pageDocument.forms = [];
  observerCallback();
  timers[1].callback();
  assert.deepEqual(states, [{
    origin: HTTPS_LOCATION.origin,
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  }]);
  observerCallback();
  assert.equal(states.length, 1, 'one submission can produce at most one SPA confirmation');
  monitor.stop();
  assert.equal(disconnected, true);
});

test('SPA monitoring is restricted to the exact current HTTPS origin', () => {
  const pageDocument = { documentElement: {}, forms: [] };
  class FakeMutationObserver { observe() {} disconnect() {} }
  const httpsMonitor = createSpaCredentialMonitor({
    pageDocument,
    pageLocation: HTTPS_LOCATION,
    MutationObserverClass: FakeMutationObserver,
  });
  assert.equal(httpsMonitor.arm('https://other.example.edu'), false);

  const httpMonitor = createSpaCredentialMonitor({
    pageDocument,
    pageLocation: { protocol: 'http:', origin: 'http://sso.example.edu' },
    MutationObserverClass: FakeMutationObserver,
  });
  assert.equal(httpMonitor.arm('http://sso.example.edu'), false);
});

test('shared connection credential auto-submit stays exact-origin and outside ordinary capture', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(
    __dirname, '..', '..', '..', '..', 'campus-preload.js',
  ), 'utf8');
  assert.match(source, /credential\.origin !== location\.origin/u);
  assert.match(source, /credential\.source === 'connection-credential'/u);
  assert.match(source, /credential\.autoSubmit === true/u);
  assert.match(source, /automaticSubmissions\.add\(form\)/u);
  assert.match(source, /automaticSubmissions\.delete\(event\.target\)/u);
  assert.match(source, /credential\.username = ''; credential\.password = ''/u);
});
