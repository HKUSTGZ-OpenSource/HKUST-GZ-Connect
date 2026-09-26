'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { CampusBrowserWindowOwner } = require('../../../../lib/browser/session/campus-browser-manager');

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.loadCalls = [];
    this.closeCalls = 0;
    this.webContents = new EventEmitter();
  }

  async loadFile(file, options) {
    this.loadCalls.push({ file, options });
  }

  isDestroyed() { return this.destroyed; }

  close() {
    this.closeCalls++;
    this.destroyed = true;
  }
}

function createOwner() {
  const windows = [];
  const commands = [];
  const resized = [];
  const closed = [];
  const missingWindowCleanup = [];
  let owner;
  owner = new CampusBrowserWindowOwner({
    BrowserWindow: class extends FakeBrowserWindow {
      constructor(windowOptions) {
        super(windowOptions);
        windows.push(this);
      }
    },
    toolbarFile: '/synthetic/campus-browser.html',
    toolbarPreload: '/synthetic/campus-browser-preload.js',
    getProfilePresentation: () => ({ schoolName: 'Example University', unverified: false }),
    getLocale: () => 'en',
    getTranslator: () => (_key, values) => `Browser for ${values.school}`,
    parentWindow: () => ({ syntheticParent: true }),
    platform: 'linux',
    windowChrome: platform => ({ titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default' }),
    onToolbarCommand: payload => commands.push(payload),
    onResize: window => resized.push(window),
    onClosed: window => closed.push({ window, duringTeardown: owner.window }),
    onMissingWindow: () => missingWindowCleanup.push(true),
  });
  return { owner, windows, commands, resized, closed, missingWindowCleanup };
}

test('window owner creates its configured toolbar and forwards only its command channel', async () => {
  const { owner, windows, commands, resized } = createOwner();
  const window = await owner.createWindow();

  assert.equal(owner.window, window);
  assert.deepEqual(window.options, {
    width: 1040,
    height: 740,
    minWidth: 660,
    minHeight: 460,
    title: 'Browser for Example University',
    backgroundColor: '#f7f9fc',
    autoHideMenuBar: true,
    titleBarStyle: 'default',
    parent: { syntheticParent: true },
    webPreferences: {
      preload: '/synthetic/campus-browser-preload.js',
      devTools: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      safeDialogs: true,
    },
  });
  assert.deepEqual(window.loadCalls, [{
    file: '/synthetic/campus-browser.html',
    options: { query: { lang: 'en', school: 'Example University', unverified: '0' } },
  }]);
  assert.deepEqual(windows, [window]);

  window.webContents.emit('ipc-message', {}, 'unrelated-channel', { command: 'close-window' });
  assert.deepEqual(commands, []);
  const payload = { command: 'new-tab', value: '' };
  window.webContents.emit('ipc-message', {}, 'campus-toolbar-command', payload);
  assert.deepEqual(commands, [payload]);
  window.emit('resize');
  assert.deepEqual(resized, [window]);
});

test('window owner retires once and preserves teardown ordering', async () => {
  const { owner, closed } = createOwner();
  const window = await owner.createWindow();

  window.emit('closed');
  window.emit('closed');

  assert.equal(owner.window, null);
  assert.deepEqual(closed, [{ window, duringTeardown: window }]);
});

test('stale window events cannot clear, command, or resize a replacement', async () => {
  const { owner, windows, closed, commands, resized } = createOwner();
  const stale = await owner.createWindow();
  const current = await owner.createWindow();
  stale.emit('closed');
  stale.webContents.emit('ipc-message', {}, 'campus-toolbar-command', { command: 'reload' });
  stale.emit('resize');

  assert.equal(owner.window, current, 'a retired window cannot clear a replacement');
  assert.equal(closed.length, 0, 'a stale close cannot tear down replacement-owned resources');
  assert.deepEqual(commands, [], 'a stale window cannot dispatch toolbar commands');
  assert.deepEqual(resized, [], 'a stale window cannot schedule replacement layout');

  current.emit('closed');
  assert.deepEqual(windows, [stale, current]);
  assert.deepEqual(closed, [{ window: current, duringTeardown: current }]);
});

test('window owner receives close requests and does not repeat a destroyed window close', async () => {
  const { owner, windows } = createOwner();
  assert.equal(owner.requestClose(), false);
  const window = await owner.createWindow();

  assert.equal(owner.requestClose(), true);
  assert.equal(window.closeCalls, 1);
  assert.equal(owner.requestClose(), false);
  assert.equal(window.closeCalls, 1);
  assert.equal(owner.window, window, 'the closed event remains the teardown authority');
  window.emit('closed');
  assert.equal(owner.window, null);
  assert.equal(windows.length, 1);
});

test('context-switch close waits for closure and returns false when the deadline wins', async () => {
  const { owner, windows } = createOwner();
  const window = await owner.createWindow();
  let timer = null;
  let cleared = null;
  const pending = owner.closeForContextSwitch({
    timeoutMs: 100,
    setTimeoutFn(callback, delay) {
      timer = { callback, delay, unref() {} };
      return timer;
    },
    clearTimeoutFn(value) { cleared = value; },
  });

  assert.equal(windows.length, 1);
  assert.equal(window.closeCalls, 1);
  assert.equal(timer.delay, 100);
  window.emit('closed');
  assert.equal(await pending, true);
  assert.equal(cleared, timer);
  assert.equal(owner.window, null);

  const { owner: unconfirmed } = createOwner();
  await unconfirmed.createWindow();
  let expire;
  const expired = unconfirmed.closeForContextSwitch({
    timeoutMs: 100,
    setTimeoutFn(callback) { expire = callback; return { unref() {} }; },
    clearTimeoutFn() {},
  });
  expire();
  assert.equal(await expired, false);
});

test('context-switch close rejects invalid deadlines without touching the window', async () => {
  const { owner, windows } = createOwner();
  const window = await owner.createWindow();
  await assert.rejects(owner.closeForContextSwitch({ timeoutMs: 99 }), /deadline/u);
  assert.equal(windows.length, 1);
  assert.equal(window.closeCalls, 0);
});

test('context-switch close delegates no-window cleanup without inventing a native window', async () => {
  const { owner, windows, missingWindowCleanup } = createOwner();
  assert.equal(await owner.closeForContextSwitch(), true);
  assert.deepEqual(missingWindowCleanup, [true]);
  assert.deepEqual(windows, []);
});

test('Campus Browser window owner remains below the M2 owner line ceiling', () => {
  const managerPath = require.resolve('../../../../lib/browser/session/campus-browser-manager');
  const source = fs.readFileSync(managerPath, 'utf8');
  const start = source.indexOf('class CampusBrowserWindowOwner {');
  const end = source.indexOf('\nfunction createCampusBrowserWindowOwner', start);
  assert.ok(start >= 0 && end > start, 'public manager defines an independently testable window owner');
  const lines = source.slice(start, end).split('\n').length - 1;
  assert.ok(lines <= 600, `window owner is ${lines} lines`);
});
