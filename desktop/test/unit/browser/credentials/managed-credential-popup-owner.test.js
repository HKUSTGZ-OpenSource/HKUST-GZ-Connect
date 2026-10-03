'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ManagedCredentialPopupOwner } = require('../../../../lib/browser/credentials/credential-controller');

function fixture({ linkPopup = true } = {}) {
  const calls = [];
  const parent = { isDestroyed: () => false };
  const campusSession = { partition: 'synthetic-campus' };
  const windows = [];
  class FakeContents extends EventEmitter {
    setWindowOpenHandler(handler) { this.popupHandler = handler; }
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeContents();
      this.destroyed = false;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setMenuBarVisibility(value) { calls.push(['menu', value]); }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
      this.webContents.emit('destroyed');
    }
  }
  const credentialController = {
    reservePopup: () => ({ active: true }),
    releasePopup: () => { calls.push(['release']); },
    linkPopup: () => linkPopup,
    closeTab: () => { calls.push(['close-tab']); },
    stage: () => { calls.push(['stage']); },
    confirmPageState: async () => { calls.push(['page-state']); },
    clear: () => { calls.push(['clear']); },
  };
  const owner = new ManagedCredentialPopupOwner({
    BrowserWindow: FakeWindow,
    getParentWindow: () => parent,
    getCampusSession: () => campusSession,
    isContextCurrent: () => true,
    campusPreload: '/app/campus-preload.js',
    credentialController,
    safePopupUrl: (url) => /^https:\/\//u.test(url),
    openOrdinaryPopup: (url) => calls.push(['ordinary', url]),
    scheduleOrdinary: (callback) => callback(),
    reportCreateFailure: () => calls.push(['create-failed']),
    markNavigation: (_popup, url, code) => calls.push(['navigation', url, code]),
    recordPortalSessionUrl: (url) => calls.push(['portal', url]),
  });
  return { owner, calls, parent, campusSession, windows };
}

test('managed popup retains the opener Session and hardens untrusted WebPreferences', () => {
  const f = fixture();
  const result = f.owner.windowOpenResponse({}, 'https://sso.example.invalid/');
  assert.equal(result.action, 'allow');
  assert.equal(result.outlivesOpener, false);
  const contents = result.createWindow({ webPreferences: {
    nodeIntegration: true, contextIsolation: false, sandbox: false, preload: '/bad.js',
  } });
  const window = f.windows[0];
  assert.equal(contents, window.webContents);
  assert.equal(window.options.parent, f.parent);
  assert.equal(window.options.webPreferences.session, f.campusSession);
  assert.equal(window.options.webPreferences.preload, '/app/campus-preload.js');
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.webSecurity, true);
  assert.equal(f.owner.popups.size, 1);
  f.owner.closeAll();
  assert.equal(window.isDestroyed(), true);
  assert.equal(f.owner.popups.size, 0);
  f.owner.closeAll();
  assert.equal(f.calls.filter(([kind]) => kind === 'close-tab').length, 1);
});

test('unsupported schemes are denied while ordinary web popups become isolated tabs', () => {
  const f = fixture();
  assert.deepEqual(f.owner.windowOpenResponse({}, 'file:///private'), { action: 'deny' });
  const credentialless = fixture();
  credentialless.owner.credentialController.reservePopup = () => null;
  assert.deepEqual(credentialless.owner.windowOpenResponse({}, 'https://library.example.invalid/'), {
    action: 'deny',
  });
  assert.deepEqual(credentialless.calls, [['ordinary', 'https://library.example.invalid/']]);
});

test('popup events keep navigation bounded and retire a crashed child once', () => {
  const f = fixture();
  const contents = f.owner.windowOpenResponse({}, 'https://sso.example.invalid/').createWindow({});
  let prevented = 0;
  contents.emit('will-navigate', { preventDefault: () => { prevented += 1; } }, 'file:///private');
  assert.equal(prevented, 1);
  contents.emit('did-navigate', {}, 'https://sso.example.invalid/next', 200);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'navigation' || kind === 'portal'), [
    ['navigation', 'https://sso.example.invalid/next', 200],
    ['portal', 'https://sso.example.invalid/next'],
  ]);
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.owner.popups.size, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'clear').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'close-tab').length, 1);
});

test('failed flow linking releases the reservation and closes the native child', () => {
  const f = fixture({ linkPopup: false });
  const response = f.owner.windowOpenResponse({}, 'https://sso.example.invalid/');
  assert.throws(() => response.createWindow({}), /lost its credential flow/u);
  assert.equal(f.windows[0].isDestroyed(), true);
  assert.equal(f.owner.popups.size, 0);
  assert.ok(f.calls.some(([kind]) => kind === 'release'));
  assert.ok(f.calls.some(([kind]) => kind === 'create-failed'));
});

test('retired parent releases the popup reservation before creating a child', () => {
  const f = fixture();
  f.owner.getParentWindow = () => null;
  const response = f.owner.windowOpenResponse({}, 'https://sso.example.invalid/');
  assert.throws(() => response.createWindow({}), /unavailable during authentication popup creation/u);
  assert.equal(f.windows.length, 0);
  assert.deepEqual(f.calls, [['release']]);
});

test('a stale ordinary popup callback cannot reopen a tab after its parent retires', () => {
  const f = fixture();
  f.owner.credentialController.reservePopup = () => null;
  let pending;
  f.owner.scheduleOrdinary = (callback) => { pending = callback; };
  assert.deepEqual(f.owner.windowOpenResponse({}, 'https://library.example.invalid/'), {
    action: 'deny',
  });
  f.owner.getParentWindow = () => null;
  pending();
  assert.equal(f.calls.some(([kind]) => kind === 'ordinary'), false);
});

test('a failed Session lookup releases a reserved authentication flow', () => {
  const f = fixture();
  f.owner.getCampusSession = () => { throw new Error('synthetic Session failure'); };
  const response = f.owner.windowOpenResponse({}, 'https://sso.example.invalid/');
  assert.throws(() => response.createWindow({}), /synthetic Session failure/u);
  assert.equal(f.windows.length, 0);
  assert.deepEqual(f.calls, [['release']]);
});

test('a retired context cannot create a popup while the old parent is still visible', () => {
  const f = fixture();
  let current = true;
  f.owner.isContextCurrent = () => current;
  const response = f.owner.windowOpenResponse({}, 'https://sso.example.invalid/');
  current = false;
  assert.throws(() => response.createWindow({}), /unavailable during authentication popup creation/u);
  assert.equal(f.windows.length, 0);
  assert.deepEqual(f.calls, [['release']]);
});
