'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { BrowserTeardownOwner } = require('../../../../lib/browser/session/browser-session-manager');

function fixture() {
  const calls = [], failing = new Set();
  const method = label => () => { calls.push(label); if (failing.has(label)) throw new Error(label); };
  const options = {
    tabs: { clear: method('tabs.clear'), closeViews: method('tabs.close'), clearTransientState: method('tabs.transient') },
    credentials: { reset: method('credentials') }, commands: { reset: method('commands') },
    pages: { reset: method('pages') }, certificates: { cancelAll: method('certificates') },
    popups: { closeAll: method('popups') }, routing: { reset: method('routing') },
    viewport: { cancelScheduledLayout: method('layout.cancel'), reset: method('viewport') },
    toolbar: { cancel: method('toolbar.cancel'), reset: method('toolbar') },
    clearViewReferences: method('references'),
  };
  return { calls, failing, options, owner: new BrowserTeardownOwner(options) };
}

test('teardown dependencies fail closed rather than inventing cleanup methods', () => {
  const f = fixture();
  assert.throws(() => new BrowserTeardownOwner({ ...f.options, popups: {} }), /dependencies/);
  assert.throws(() => new BrowserTeardownOwner({ ...f.options, windowOwner: {} }), /dependencies/);
});

test('before-create failure attempts other retirements and cannot commit new-window readiness', () => {
  const f = fixture(); f.failing.add('credentials');
  assert.throws(() => f.owner.beforeCreate(), error => error instanceof AggregateError && error.errors[0].message === 'credentials');
  assert.deepEqual(f.calls, ['layout.cancel', 'toolbar.cancel', 'credentials', 'commands', 'pages', 'toolbar']);
  f.failing.clear(); f.owner.beforeCreate();
});

test('timer cancellation attempts both independent handles and retains all causes', () => {
  const f = fixture(); f.failing.add('layout.cancel'); f.failing.add('toolbar.cancel');
  assert.throws(() => f.owner.cancel(), error => {
    assert.deepEqual(error.errors.map(error => error.message), ['layout.cancel', 'toolbar.cancel']); return true;
  });
  assert.deepEqual(f.calls, ['layout.cancel', 'toolbar.cancel']);
});

test('closed cleanup attempts every owner but only commits references when all confirm', () => {
  const f = fixture(); f.failing.add('pages'); f.failing.add('popups');
  assert.throws(() => f.owner.closed(), /cleanup is unconfirmed/);
  assert.deepEqual(f.calls, ['layout.cancel', 'toolbar.cancel', 'credentials', 'commands', 'pages',
    'certificates', 'tabs.close', 'popups', 'routing', 'viewport', 'toolbar']);
  f.failing.clear(); f.calls.length = 0; f.owner.closed(); f.owner.closed();
  assert.deepEqual(f.calls.slice(-2), ['tabs.clear', 'references']);
});

test('reference commit failure never clears views and remains an actionable failure', () => {
  const f = fixture(); f.failing.add('tabs.clear');
  assert.throws(() => f.owner.closed(), /cleanup is unconfirmed/);
  assert.equal(f.calls.includes('references'), false);
});

test('native close is still attempted after admission cleanup fails; native failure also survives', () => {
  const f = fixture(); f.failing.add('credentials'); f.failing.add('native.close');
  const native = { window: {}, requestClose: () => { f.calls.push('native.close'); throw new Error('native.close'); }, clear: () => false };
  const owner = new BrowserTeardownOwner({ ...f.options, windowOwner: native });
  assert.throws(() => owner.close(), error => {
    assert.deepEqual(error.errors.map(error => error.message), ['credentials', 'native.close']); return true;
  });
  assert.equal(f.calls.includes('native.close'), true);
  assert.equal(f.calls.includes('tabs.clear'), false);
});

test('windowless close is repeatable and retains transient ownership until cleanup succeeds', () => {
  const f = fixture(); f.failing.add('tabs.transient');
  assert.throws(() => f.owner.close(), /cleanup is unconfirmed/);
  assert.ok(f.calls.includes('routing') && f.calls.includes('viewport') && f.calls.includes('toolbar'));
  assert.equal(f.calls.includes('tabs.clear'), false);
  f.failing.clear(); f.owner.close(); f.owner.close();
  assert.deepEqual(f.calls.slice(-2), ['tabs.clear', 'references']);
});

test('the teardown coordinator remains below the M2 per-owner ceiling', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/browser/session/browser-session-manager'), 'utf8');
  const start = source.indexOf('class BrowserTeardownOwner {'), end = source.indexOf('\nfunction calendarWeekQuery', start);
  assert.ok(start >= 0 && end > start);
  assert.ok(source.slice(start, end).split('\n').length <= 600);
});
