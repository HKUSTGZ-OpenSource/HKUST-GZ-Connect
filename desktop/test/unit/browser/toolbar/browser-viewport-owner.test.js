'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserViewportOwner } = require('../../../../lib/browser/toolbar/browser-toolbar-owner');

function fixture() {
  const calls = [];
  const queued = [];
  let currentWindow = { isDestroyed: () => false, getContentSize: () => [900, 700],
    webContents: { send: (...args) => calls.push(['send', ...args]) } };
  let active = { view: { setBounds: bounds => calls.push(['bounds', bounds]),
    webContents: { isDestroyed: () => false,
      stopFindInPage: value => calls.push(['stop', value]), focus: () => calls.push(['focus']) } } };
  let current = true;
  const owner = new BrowserViewportOwner({
    getWindow: () => currentWindow, getActiveTab: () => active,
    isContextCurrent: () => current,
    updateToolbar: () => calls.push(['toolbar']), toolbarHeight: 108, findBarHeight: 34,
    timers: { setImmediate(callback) {
      const handle = { callback, unref: () => calls.push(['unref']) };
      queued.push(handle); return handle;
    }, clearImmediate: handle => calls.push(['cancel', handle]) },
  });
  return { owner, calls, queued, window: currentWindow, tab: active,
    setWindow: value => { currentWindow = value; },
    setTab: value => { active = value; }, retire: () => { current = false; } };
}

test('viewport keeps dimensions and find-focus commands without owning tabs', () => {
  const f = fixture();
  f.owner.layout();
  assert.deepEqual(f.calls.at(-1), ['bounds', { x: 0, y: 108, width: 900, height: 592 }]);
  f.owner.setFindBar(true);
  assert.equal(f.owner.findOpen, true);
  assert.deepEqual(f.calls.slice(-3), [
    ['bounds', { x: 0, y: 142, width: 900, height: 558 }],
    ['toolbar'], ['send', 'campus-toolbar-focus', 'find'],
  ]);
  f.owner.setFindBar(false);
  assert.equal(f.owner.findOpen, false);
  assert.deepEqual(f.calls.slice(-4), [
    ['bounds', { x: 0, y: 108, width: 900, height: 592 }],
    ['toolbar'], ['stop', 'clearSelection'], ['focus'],
  ]);
  f.window.getContentSize = () => [0, 100];
  f.owner.layout();
  assert.deepEqual(f.calls.at(-1), ['bounds', { x: 0, y: 108, width: 1, height: 1 }]);
});

test('resize bursts coalesce and use the live selected tab at execution', () => {
  const f = fixture();
  f.owner.scheduleLayout(); f.owner.scheduleLayout();
  assert.equal(f.queued.length, 1);
  const replacementCalls = [];
  f.setTab({ view: { setBounds: value => replacementCalls.push(value),
    webContents: { isDestroyed: () => false } } });
  f.queued[0].callback();
  assert.equal(f.owner.scheduledLayout, null);
  assert.equal(replacementCalls.length, 1);
  assert.equal(f.calls.some(([name]) => name === 'bounds'), false);
});

test('cancel and reset fence a late callback without clearing its replacement', () => {
  const f = fixture();
  f.owner.scheduleLayout();
  const old = f.queued[0];
  f.owner.reset(); f.owner.reset();
  assert.equal(f.owner.findOpen, false);
  assert.equal(f.owner.scheduledLayout, null);
  f.owner.scheduleLayout();
  const replacement = f.owner.scheduledLayout;
  old.callback();
  assert.equal(f.owner.scheduledLayout, replacement);
  assert.equal(f.calls.some(([name]) => name === 'bounds'), false);
  replacement.callback();
  assert.equal(f.calls.filter(([name]) => name === 'bounds').length, 1);
  assert.equal(f.owner.scheduledLayout, null);
});

test('replaced/closed windows, destroyed pages and retired contexts are inert', () => {
  for (const retire of [f => f.setWindow(null), f => f.setWindow({ ...f.window }),
    f => { f.window.isDestroyed = () => true; }, f => f.retire()]) {
    const f = fixture(); f.owner.scheduleLayout(); retire(f);
    f.queued[0].callback();
    assert.equal(f.calls.some(([name]) => name === 'bounds'), false);
    assert.equal(f.owner.scheduledLayout, null);
  }
  for (const retire of [f => f.setTab(null),
    f => { f.tab.view.webContents.isDestroyed = () => true; },
    f => f.setWindow(null), f => f.retire()]) {
    const f = fixture(); retire(f); f.owner.layout();
    assert.equal(f.calls.some(([name]) => name === 'bounds'), false);
  }
  const f = fixture(); f.retire(); f.owner.setFindBar(true); f.owner.scheduleLayout();
  assert.equal(f.owner.findOpen, false);
  assert.equal(f.queued.length, 0);
  assert.deepEqual(f.calls, []);
});

test('viewport dependencies and fixed chrome dimensions are bounded', () => {
  assert.throws(() => new BrowserViewportOwner(), /dependencies/);
  const f = fixture();
  assert.equal(f.owner.findOpen, false);
  assert.equal(f.owner.scheduledLayout, null);
  for (const value of [0, -1, Infinity, NaN, 1.5, '108']) {
    assert.throws(() => new BrowserViewportOwner({
      getWindow: () => null, getActiveTab: () => null, isContextCurrent: () => true,
      updateToolbar: () => {}, toolbarHeight: value, findBarHeight: 34,
    }), /dependencies/);
  }
});

test('a synchronous toolbar effect cannot focus a retired window', () => {
  for (const open of [true, false]) {
    const f = fixture();
    f.owner.updateToolbar = () => f.retire();
    f.owner.setFindBar(open);
    assert.equal(f.calls.some(([name]) => ['send', 'stop', 'focus'].includes(name)), false);
  }
});
