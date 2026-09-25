'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const desktopRoot = path.resolve(__dirname, '..', '..', '..', '..');
const {
  CREDENTIAL_CANDIDATE_TTL_MS,
  CredentialController,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
} = require('../../../../lib/browser/credentials/credential-controller');

function fixture(overrides = {}) {
  let currentOrigin = overrides.currentOrigin || 'https://sso.example.edu';
  const prompts = [];
  const saved = [];
  const errors = [];
  const timers = [];
  const clearedTimers = [];
  const vault = overrides.vault || {
    get: async () => null,
    save: async (...values) => saved.push(values),
  };
  const dialog = overrides.dialog || {
    showMessageBox: async (_window, options) => {
      prompts.push(options);
      return { response: 0 };
    },
  };
  const window = overrides.window || { isDestroyed: () => false };
  const controller = new CredentialController({
    vault,
    dialog,
    originForTab: (tab) => tab?.origin || currentOrigin,
    windowForPrompt: () => window,
    t: (key, vars) => vars?.host ? `${key}:${vars.host}` : key,
    onError: (message) => errors.push(message),
    setTimer: (callback, delay) => {
      const handle = { callback, delay, unref() { this.unrefCalled = true; } };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => clearedTimers.push(handle),
  });
  return {
    controller,
    clearedTimers,
    errors,
    prompts,
    saved,
    setCurrentOrigin(value) { currentOrigin = value; },
    timers,
  };
}

function candidate(overrides = {}) {
  return {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'local-secret',
    ...overrides,
  };
}

test('staging accepts only the exact current HTTPS origin and bounded values', () => {
  const { controller, timers } = fixture();
  const tab = {};
  for (const invalid of [
    candidate({ origin: 'http://sso.example.edu' }),
    candidate({ origin: 'https://sso.example.edu/' }),
    candidate({ origin: 'https://other.example.edu' }),
    candidate({ password: '' }),
    candidate({ username: 'u'.repeat(MAX_USERNAME_LENGTH + 1) }),
    candidate({ password: 'p'.repeat(MAX_PASSWORD_LENGTH + 1) }),
  ]) {
    assert.equal(controller.stage(tab, invalid), false);
  }

  assert.equal(controller.stage(tab, candidate()), true);
  assert.deepEqual(tab.pendingCredential, {
    origin: 'https://sso.example.edu',
    username: 'student001',
    password: 'local-secret',
    navigationCommitted: false,
    navigationSuccessful: false,
    destinationOrigin: '',
    challengeObserved: false,
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, CREDENTIAL_CANDIDATE_TTL_MS);
  assert.equal(timers[0].unrefCalled, true);
});

test('a candidate is offered only after a successful matching page state', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu', hasLoginForm: false, hasChallengeForm: false,
  }), false, 'submission alone must never prompt');
  assert.equal(state.prompts.length, 0);

  // SSO may finish on a different HTTPS origin. The destination page state
  // must match the live tab, while the saved scope remains the form origin.
  assert.equal(state.controller.markNavigation(tab, 'https://portal.example.edu/home', 302), true);
  state.setCurrentOrigin('https://portal.example.edu');
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://portal.example.edu', hasLoginForm: false, hasChallengeForm: false,
  }), true);
  assert.equal(state.prompts.length, 1);
  assert.deepEqual(state.saved, [[
    'https://sso.example.edu', 'student001', 'local-secret',
  ]]);
  assert.equal(tab.pendingCredential, null);
});

test('a stable SPA transition can offer an exact-origin candidate without navigation', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());

  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  }), true);
  assert.equal(state.prompts.length, 1, 'SPA success still requires an explicit user prompt');
  assert.deepEqual(state.saved, [[
    'https://sso.example.edu', 'student001', 'local-secret',
  ]]);
  assert.equal(tab.pendingCredential, null);
});

test('a challenge page cannot confirm login and retains the candidate only for its bounded TTL', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());
  state.controller.markNavigation(tab, 'https://sso.example.edu/mfa', 302);

  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
    hasChallengeForm: true,
  }), false);
  assert.equal(state.prompts.length, 0);
  assert.ok(tab.pendingCredential, 'MFA progress is not a failed password submission');

  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
  }), true, 'an explicit later post-challenge page can offer the original password');
  assert.equal(state.prompts.length, 1);
  assert.equal(tab.pendingCredential, null);
});

test('a committed challenge may finish inside the same SPA document only after being observed', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());
  state.controller.markNavigation(tab, 'https://mfa.example.edu/challenge', 302);
  state.setCurrentOrigin('https://mfa.example.edu');

  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://mfa.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  }), false, 'an unobserved DOM change is not challenge completion evidence');
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://mfa.example.edu',
    hasLoginForm: false,
    hasChallengeForm: true,
  }), false);
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://mfa.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  }), true);
  assert.equal(state.prompts.length, 1);
  assert.deepEqual(state.saved, [[
    'https://sso.example.edu', 'student001', 'local-secret',
  ]]);
});

test('a popup challenge blocks the opener and never receives a password copy', async () => {
  const state = fixture();
  const owner = { origin: 'https://sso.example.edu' };
  const popup = { origin: 'https://mfa.example.edu' };
  state.controller.stage(owner, candidate());
  state.controller.markNavigation(owner, 'https://sso.example.edu/waiting', 200);

  const reservation = state.controller.reservePopup(owner);
  assert.equal(await state.controller.confirmPageState(owner, {
    origin: owner.origin, hasLoginForm: false, hasChallengeForm: false,
  }), false, 'a deferred popup blocks the opener before the new tab exists');
  assert.equal(state.controller.linkPopup(reservation, popup), true);
  assert.equal(popup.pendingCredential, undefined, 'the password is owned only by the opener');

  state.controller.markNavigation(popup, 'https://mfa.example.edu/challenge', 200);
  assert.equal(await state.controller.confirmPageState(popup, {
    origin: popup.origin, hasLoginForm: false, hasChallengeForm: true,
  }), false);
  assert.equal(await state.controller.confirmPageState(owner, {
    origin: owner.origin, hasLoginForm: false, hasChallengeForm: false,
  }), false, 'the waiting opener cannot conclude success during popup MFA');
  assert.equal(await state.controller.confirmPageState(popup, {
    origin: popup.origin, hasLoginForm: false, hasChallengeForm: false,
  }), true, 'the observed challenge tab may provide post-challenge evidence');
  assert.equal(state.prompts.length, 1);
  assert.deepEqual(state.saved, [[
    'https://sso.example.edu', 'student001', 'local-secret',
  ]]);
});

test('closing a challenge popup requires a fresh opener navigation before saving', async () => {
  const state = fixture();
  const owner = { origin: 'https://sso.example.edu' };
  const popup = { origin: 'https://mfa.example.edu' };
  state.controller.stage(owner, candidate());
  state.controller.markNavigation(owner, 'https://sso.example.edu/waiting', 200);
  const reservation = state.controller.reservePopup(owner);
  state.controller.linkPopup(reservation, popup);
  state.controller.markNavigation(popup, 'https://mfa.example.edu/challenge', 200);
  await state.controller.confirmPageState(popup, {
    origin: popup.origin, hasLoginForm: false, hasChallengeForm: true,
  });
  state.controller.closeTab(popup);

  assert.equal(await state.controller.confirmPageState(owner, {
    origin: owner.origin, hasLoginForm: false, hasChallengeForm: false,
  }), false, 'the pre-challenge waiting document is stale');
  assert.equal(state.prompts.length, 0);
  state.controller.markNavigation(owner, 'https://sso.example.edu/home', 200);
  assert.equal(await state.controller.confirmPageState(owner, {
    origin: owner.origin, hasLoginForm: false, hasChallengeForm: false,
  }), true);
  assert.equal(state.prompts.length, 1);
});

test('missing challenge classification is never accepted as post-login evidence', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());
  state.controller.markNavigation(tab, 'https://sso.example.edu/home', 200);
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
  }), false);
  assert.equal(state.prompts.length, 0);
  assert.ok(tab.pendingCredential);
});

test('SPA evidence cannot cross origins or override a main-frame navigation', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://other.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  }), false);
  assert.equal(state.prompts.length, 0);
  assert.ok(tab.pendingCredential);

  state.controller.markNavigation(tab, 'https://sso.example.edu/home', 200);
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu',
    hasLoginForm: false,
    hasChallengeForm: false,
    transition: 'same-document',
  }), false, 'a committed document must use navigation evidence instead');
  assert.equal(state.prompts.length, 0);
});

test('a failed same-document login clears its staged password', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate({ password: 'wrong-secret' }));
  const retained = tab.pendingCredential;
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu',
    hasLoginForm: true,
    hasChallengeForm: false,
    transition: 'same-document',
  }), false);
  assert.equal(retained.password, '');
  assert.equal(tab.pendingCredential, null);
  assert.equal(state.prompts.length, 0);
});

test('401, 403, other rejected responses, and insecure navigation clear secrets immediately', () => {
  for (const [url, status] of [
    ['https://sso.example.edu/login', 401],
    ['https://sso.example.edu/login', 403],
    ['https://sso.example.edu/login', 500],
    ['http://sso.example.edu/login', 302],
  ]) {
    const { controller } = fixture();
    const tab = {};
    controller.stage(tab, candidate());
    const retained = tab.pendingCredential;
    assert.equal(controller.markNavigation(tab, url, status), false);
    assert.equal(retained.password, '', `${status} must erase the staged secret`);
    assert.equal(tab.pendingCredential, null);
  }
});

test('a completed page that still has a login form clears the candidate', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate({ password: 'wrong-secret' }));
  const retained = tab.pendingCredential;
  state.controller.markNavigation(tab, 'https://sso.example.edu/login?error=1', 200);
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://sso.example.edu', hasLoginForm: true, hasChallengeForm: false,
  }), false);
  assert.equal(retained.password, '');
  assert.equal(tab.pendingCredential, null);
  assert.equal(state.prompts.length, 0);
});

test('timeout and every browser lifecycle cleanup use one zeroizing clear operation', () => {
  for (const reason of ['timeout', 'failed navigation', 'route change', 'tab close', 'renderer crash']) {
    const state = fixture();
    const tab = {};
    state.controller.stage(tab, candidate({ password: `${reason}-secret` }));
    const retained = tab.pendingCredential;
    if (reason === 'timeout') state.timers[0].callback();
    else state.controller.clear(tab);
    assert.equal(retained.password, '', `${reason} did not erase the candidate`);
    assert.equal(tab.pendingCredential, null);
  }
});

test('stale page state cannot confirm a candidate and remains bounded by its timer', async () => {
  const state = fixture();
  const tab = {};
  state.controller.stage(tab, candidate());
  state.controller.markNavigation(tab, 'https://portal.example.edu/home', 200);
  state.setCurrentOrigin('https://newer.example.edu');
  assert.equal(await state.controller.confirmPageState(tab, {
    origin: 'https://portal.example.edu', hasLoginForm: false, hasChallengeForm: false,
  }), false);
  assert.ok(tab.pendingCredential, 'a stale prior document must not consume a newer flow');
  state.timers[0].callback();
  assert.equal(tab.pendingCredential, null);
});

test('save prompts are single-flight per origin and every candidate copy is erased', async () => {
  let resolvePrompt;
  const promptStarted = new Promise((resolve) => { resolvePrompt = resolve; });
  let releasePrompt;
  const promptFinished = new Promise((resolve) => { releasePrompt = resolve; });
  let promptCount = 0;
  const state = fixture({
    dialog: {
      showMessageBox: async () => {
        promptCount++;
        resolvePrompt();
        await promptFinished;
        return { response: 1 };
      },
    },
  });
  const first = candidate({ password: 'first-secret' });
  const second = candidate({ password: 'second-secret' });
  const firstOffer = state.controller.offer(first);
  await promptStarted;
  assert.equal(await state.controller.offer(second), false);
  assert.equal(second.password, '', 'the suppressed duplicate must be erased');
  releasePrompt();
  assert.equal(await firstOffer, true);
  assert.equal(first.password, '');
  assert.equal(promptCount, 1);
  assert.equal(state.controller.prompts.size, 0);
});

test('CampusBrowser delegates candidate state and keeps all lifecycle clear calls', () => {
  const source = fs.readFileSync(
    path.join(desktopRoot, 'lib', 'browser', 'session', 'campus-browser.js'),
    'utf8',
  );
  assert.match(source, /new CredentialController\(\{/);
  assert.match(source, /this\.credentialController\.stage\(tab, candidate\)/);
  assert.match(source, /this\.credentialController\.confirmPageState\(tab, candidate\)/);
  assert.match(source, /markCredentialNavigation\(tab, url, httpResponseCode\)/);
  for (const fragment of [
    'const handleLoadFailure',
    '\n  handleRendererCrash(tab, details = {})',
    '\n  async setTabRoute',
  ]) {
    const start = source.indexOf(fragment);
    assert.notEqual(start, -1, `missing lifecycle boundary: ${fragment}`);
    assert.match(source.slice(start, start + 1800), /clearCredentialCandidate\(tab\)/,
      `${fragment} must clear any staged credential`);
  }
  const closeStart = source.indexOf('\n  closeTab(id)');
  assert.notEqual(closeStart, -1);
  const owner = fs.readFileSync(path.join(desktopRoot, 'lib', 'browser', 'tabs', 'tab-manager.js'), 'utf8');
  assert.match(source.slice(closeStart, closeStart + 100), /this\.tabManager\.close\(id\)/);
  assert.match(source, /closeTabState: tab => this\.credentialController\.closeTab\(tab\)/);
  assert.match(owner.slice(owner.indexOf('\n  close(id)'), owner.indexOf('\n  clearTransientState()')),
    /this\.effects\.closeTabState\(tab\)/,
    'closing a popup must unlink it without copying or prematurely consuming the owner secret');
  const windowClose = source.indexOf("this.window.on('closed'");
  assert.notEqual(windowClose, -1);
  assert.match(source.slice(windowClose, windowClose + 350), /this\.tabManager\.closeViews\(\)/);
  assert.match(source, /clearCredentialCandidate: tab => this\.clearCredentialCandidate\(tab\)/);
  for (const method of ['clearTransientState', 'closeViews']) {
    const start = owner.indexOf(`\n  ${method}()`);
    assert.notEqual(start, -1);
    assert.match(owner.slice(start, start + 350), /this\.effects\.clearCredentialCandidate\(tab\)/);
  }
  const noWindowClose = source.indexOf('\n  close()');
  assert.match(source.slice(noWindowClose, noWindowClose + 500), /this\.tabManager\.clearTransientState\(\)/);
});
