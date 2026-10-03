'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/update-notices/index.mjs');

class Element {
  constructor() {
    this.hidden = false;
    this.innerHTML = '';
    this.disabled = false;
    this.listeners = new Map();
    this.removed = [];
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, callback) {
    this.removed.push([type, callback]);
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((value) => value !== callback));
  }

  dispatch(type, event = {}) {
    return (this.listeners.get(type) || []).map((callback) => callback(event));
  }
}

function fixture(overrides = {}) {
  const updateHint = new Element();
  const checkUpdateBtn = new Element();
  const timers = new Map();
  const clearedTimers = [];
  let timerSequence = 0;
  const checkCalls = [];
  const opened = [];
  const document = {
    getElementById(id) {
      if (id === 'updateHint') return updateHint;
      if (id === 'checkUpdateBtn') return checkUpdateBtn;
      return null;
    },
  };
  const dependencies = {
    document,
    translate: (key, values = {}) => `${key}:${Object.values(values).join('|')}`,
    escapeHtml: (value) => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    checkUpdate: async (manual) => { checkCalls.push(manual); return null; },
    openExternal: (url) => { opened.push(url); },
    timers: {
      setTimeout(callback, delay) {
        const id = ++timerSequence;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        clearedTimers.push(id);
        timers.delete(id);
      },
    },
    ...overrides,
  };
  const feature = create(dependencies);
  return {
    feature,
    updateHint,
    checkUpdateBtn,
    checkCalls,
    opened,
    timers,
    clearedTimers,
    fireTimer(id) {
      const timer = timers.get(id);
      if (!timer) return false;
      timers.delete(id);
      timer.callback();
      return true;
    },
    dependencies,
  };
}

const available = (url = 'https://github.com/synthetic/project/releases/tag/v99.0.0') => ({
  updateAvailable: true,
  latestVersion: '99.0.0<untrusted>',
  url,
});

test('creation requires explicit translation and HTML escaping ports', () => {
  const f = fixture();
  f.feature.dispose();
  assert.throws(() => create({ ...f.dependencies, translate: undefined }), /dependencies are incomplete/u);
  assert.throws(() => create({ ...f.dependencies, escapeHtml: undefined }), /dependencies are incomplete/u);
});

test('update notice owner delegates one stable link listener and opens only its current Main URL', () => {
  const f = fixture();
  assert.equal(f.feature.start(), true);
  assert.equal(f.feature.start(), false);
  assert.equal(f.updateHint.listeners.get('click').length, 1);
  assert.equal(f.checkUpdateBtn.listeners.get('click').length, 1);

  const result = available();
  f.feature.renderResult(result);
  assert.equal(f.updateHint.hidden, false);
  assert.match(f.updateHint.innerHTML, /settings\.updateAvailable/u);
  assert.match(f.updateHint.innerHTML, /99\.0\.0&lt;untrusted&gt;/u);
  assert.equal(f.timers.size, 0, 'available updates remain sticky');

  f.updateHint.dispatch('click', {
    target: { closest: (selector) => selector === '#updateDownload' ? {} : null },
  });
  assert.deepEqual(f.opened, [result.url]);
  f.updateHint.dispatch('click', { target: { closest: () => null } });
  assert.deepEqual(f.opened, [result.url]);

  assert.equal(f.feature.dispose(), true);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.updateHint.listeners.get('click').length, 0);
  assert.equal(f.checkUpdateBtn.listeners.get('click').length, 0);
});

test('manual result controls transient feedback while automatic no-update preserves the current hint', () => {
  const f = fixture();
  f.feature.start();
  const current = available();
  f.feature.renderResult(current);
  const stickyMarkup = f.updateHint.innerHTML;

  f.feature.renderResult({ updateAvailable: false }, { manual: false });
  assert.equal(f.updateHint.innerHTML, stickyMarkup);
  assert.equal(f.updateHint.hidden, false);

  return f.feature.runCheck(false).then(() => {
    assert.deepEqual(f.checkCalls, [false]);
    assert.equal(f.updateHint.innerHTML, stickyMarkup);
  }).then(() => {
    f.feature.renderResult({ updateAvailable: false }, { manual: true });
    assert.equal(f.updateHint.innerHTML, 'settings.updateLatest:');
    assert.equal(f.timers.size, 1);
    const [[timerId, timer]] = f.timers;
    assert.equal(timer.delay, 3500);
    f.feature.renderResult(available('https://github.com/synthetic/project/releases/tag/v99.0.1'));
    assert.ok(f.clearedTimers.includes(timerId), 'new sticky text retires the prior timer');
    assert.equal(f.timers.size, 0);
    assert.equal(f.updateHint.hidden, false);

    f.feature.renderResult({ updateAvailable: false }, { manual: true });
    assert.equal(f.timers.size, 1);
    const [replacementTimerId] = f.timers.keys();
    assert.equal(f.fireTimer(replacementTimerId), true);
    assert.equal(f.updateHint.hidden, true);
    assert.equal(f.updateHint.innerHTML, 'settings.updateLatest:');

    f.feature.renderResult(null, { manual: true });
    assert.equal(f.updateHint.innerHTML, 'settings.updateFailed:');
    f.updateHint.dispatch('click', {
      target: { closest: (selector) => selector === '#updateDownload' ? {} : null },
    });
    assert.deepEqual(f.opened, [], 'an explicit manual no-result clears the prior verified URL');
    f.feature.dispose();
  });
});

test('manual IPC rejection displays failure, reenables the button, and retains the prior verified URL', async () => {
  const f = fixture({ checkUpdate: async (manual) => {
    f.checkCalls.push(manual);
    throw new Error('synthetic update failure');
  } });
  f.feature.start();
  const current = available();
  f.feature.renderResult(current);

  const [manualCheck] = f.checkUpdateBtn.dispatch('click');
  assert.equal(f.checkUpdateBtn.disabled, true);
  await manualCheck;
  assert.equal(f.checkUpdateBtn.disabled, false);
  assert.equal(f.updateHint.innerHTML, 'settings.updateFailed:');
  f.updateHint.dispatch('click', {
    target: { closest: (selector) => selector === '#updateDownload' ? {} : null },
  });
  assert.deepEqual(f.checkCalls, [true]);
  assert.deepEqual(f.opened, [current.url], 'a rejected request does not clear the existing URL');
  f.feature.dispose();
});

test('manual button force flag and disposal fence prevent late async publication or DOM access', async () => {
  let resolveCheck;
  const f = fixture({ checkUpdate: (manual) => {
    f.checkCalls.push(manual);
    return new Promise((resolve) => { resolveCheck = resolve; });
  } });
  f.feature.start();
  f.feature.renderResult({ updateAvailable: false }, { manual: true });
  const beforeDispose = f.updateHint.innerHTML;
  const [timerId] = f.timers.keys();
  const staleTimer = f.timers.get(timerId).callback;
  const [pending] = f.checkUpdateBtn.dispatch('click');
  await Promise.resolve();
  assert.deepEqual(f.checkCalls, [true]);
  assert.equal(f.checkUpdateBtn.disabled, true);

  assert.equal(f.feature.dispose(), true);
  assert.ok(f.clearedTimers.includes(timerId));
  assert.equal(f.updateHint.removed.length, 1);
  assert.equal(f.checkUpdateBtn.removed.length, 1);
  resolveCheck(available());
  await pending;
  staleTimer();
  assert.equal(f.updateHint.innerHTML, beforeDispose);
  assert.equal(f.checkUpdateBtn.disabled, true, 'finally must not touch retired controls');
  assert.equal(f.updateHint.hidden, false, 'a queued retired timer cannot hide the notice');
  assert.equal(f.feature.start(), false);
});
