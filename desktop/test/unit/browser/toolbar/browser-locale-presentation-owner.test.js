'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserLocalePresentationOwner } = require('../../../../lib/browser/toolbar/browser-toolbar-owner');
function fixture() {
  const calls = [], state = { locale: 'zh', translator: null, presentation: { schoolName: 'Example University', unverified: true } };
  const window = { isDestroyed: () => false, setTitle: value => calls.push(['title', value]),
    webContents: { send: (...args) => calls.push(['send', ...args]) } };
  state.window = window;
  const ports = { getWindow: () => state.window, getPresentation: () => state.presentation, getLocale: () => state.locale,
    setLocale: value => { state.locale = value; calls.push(['locale', value]); },
    setTranslator: value => { state.translator = value; calls.push('translator'); },
    translate: (key, vars) => { calls.push(['translate', key, vars]); return key; },
    createTranslator: locale => { assert.equal(state.locale, locale); return () => locale; },
    refreshWorkspaceHomes: () => calls.push('workspace'), updateToolbar: () => calls.push('toolbar') };
  return { calls, state, window, ports, owner: new BrowserLocalePresentationOwner(ports) };
}

test('locale projection uses original state-before-title/message/Workspace/toolbar order', () => {
  const f = fixture(), translator = () => 'custom'; f.owner.set('en', translator);
  assert.equal(f.state.translator, translator);
  assert.deepEqual(f.calls, [['locale', 'en'], 'translator', ['translate', 'browser.unverifiedSuffix', undefined],
    ['translate', 'browser.windowTitleForSchool', { school: 'Example University', trust: 'browser.unverifiedSuffix' }],
    ['title', 'browser.windowTitleForSchool'], ['send', 'campus-toolbar-locale', 'en'], 'workspace', 'toolbar']);
});

test('missing and destroyed window still update locale/translator without presentation effects', () => {
  for (const condition of ['missing', 'destroyed']) {
    const f = fixture(); if (condition === 'missing') f.state.window = null; else f.window.isDestroyed = () => true;
    f.owner.set('unsupported'); assert.equal(f.state.locale, 'zh'); assert.equal(f.state.translator(), 'zh');
    assert.deepEqual(f.calls, [['locale', 'zh'], 'translator']);
  }
});

test('live getters reflect current Profile presentation and optional native message support', () => {
  const f = fixture(); f.state.presentation = { schoolName: 'Changed University', unverified: false };
  delete f.window.webContents.send; f.owner.set('en');
  assert.deepEqual(f.calls[2], ['translate', 'browser.windowTitleForSchool', { school: 'Changed University', trust: '' }]);
  assert.equal(f.calls.some(value => value?.[0] === 'send'), false);
  assert.deepEqual(f.calls.slice(-2), ['workspace', 'toolbar']);
});

test('presentation errors preserve the original failure and do not silently continue later effects', () => {
  for (const port of ['translate', 'refreshWorkspaceHomes', 'updateToolbar']) {
    const f = fixture(), failure = new Error(`synthetic ${port} failure`); f.owner[port] = () => { throw failure; };
    assert.throws(() => f.owner.set('en'), error => error === failure);
    if (port !== 'updateToolbar') assert.equal(f.calls.includes('toolbar'), false);
    if (port === 'translate') assert.equal(f.calls.includes('workspace'), false);
  }
});

test('no pending timer or state copy survives repeated missing-window projection', () => {
  const f = fixture(); f.state.window = null;
  for (const locale of ['en', 'zh', 'en']) f.owner.set(locale);
  assert.equal(f.state.locale, 'en'); assert.equal(f.calls.length, 6);
  assert.deepEqual(Object.keys(f.owner).sort(), Object.keys(f.ports).sort());
});

test('invalid bounded ports are rejected before presentation', () => {
  const f = fixture(); for (const key of Object.keys(f.ports)) {
    assert.throws(() => new BrowserLocalePresentationOwner({ ...f.ports, [key]: null }), /dependencies/);
  }
  assert.deepEqual(f.calls, []);
});
