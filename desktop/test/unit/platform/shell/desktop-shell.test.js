'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DesktopShell } = require('../../../../lib/platform/shell/desktop-shell');

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.url = 'file:///app/index.html';
  }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  getURL() { return this.url; }
  send(...args) { this.sent.push(args); }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeContents();
    this.destroyed = false;
    this.visible = true;
    this.minimized = false;
    this.contentSize = [500, 640];
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.focused = true; }
  destroy() {
    this.destroyed = true;
    this.webContents.emit('destroyed');
    this.emit('closed');
  }
  loadFile(file) { this.loadedFile = file; }
  getContentSize() { return this.contentSize; }
  setContentSize(width, height) { this.contentSize = [width, height]; }
}

class FakeTray extends EventEmitter {
  constructor(image) { super(); this.image = image; this.destroyed = false; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  setToolTip(value) { this.tooltip = value; }
  setContextMenu(value) { this.menu = value; }
}

function fixture(overrides = {}) {
  const calls = [];
  const app = {
    isPackaged: false,
    isReady: () => true,
    quit: () => calls.push('quit'),
  };
  const Menu = {
    buildFromTemplate: (template) => template,
    setApplicationMenu: (menu) => calls.push(['menu', menu]),
  };
  const shell = new DesktopShell({
    app,
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu,
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 22, height: 22 }),
        resize: () => ({ isEmpty: () => false }),
      }),
    },
    dialog: { showMessageBox: async () => ({ response: 2, checkboxChecked: false }) },
    baseDirectory: '/fixture/app',
    controlRendererFile: '/fixture/app/renderer/index.html',
    preloadFile: '/fixture/app/preload.js',
    platform: 'darwin',
    translate: (key, vars) => vars?.status ? `${key}:${vars.status}` : key,
    getConnectionState: () => ({ connected: false, connecting: false }),
    getCloseAction: () => 'ask',
    connect: async () => { calls.push('connect'); return { ok: true }; },
    disconnect: async () => { calls.push('disconnect'); return { ok: true }; },
    openCampusBrowser: async () => { calls.push('browser'); },
    rememberCloseAction: async (action) => { calls.push(['remember', action]); },
    disposeLifecycle: () => calls.push('dispose'),
    cleanupQuit: async () => calls.push('cleanup'),
    onControlRendererUnavailable: (reason) => calls.push(['renderer-lost', reason]),
    onWindowError: (error) => calls.push(['error', error.message]),
    ...overrides,
  });
  return { app, calls, Menu, shell };
}

test('control window is sandboxed, navigation-closed, sendable and bounded-resizable', () => {
  const f = fixture();
  const window = f.shell.createWindow();
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.deepEqual(window.webContents.windowOpenHandler(), { action: 'deny' });
  let prevented = false;
  window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://evil.test');
  assert.equal(prevented, true);
  assert.equal(f.shell.send('status', { ok: true }), true);
  assert.deepEqual(window.webContents.sent, [['status', { ok: true }]]);
  assert.equal(f.shell.resize(200), true);
  assert.ok(window.contentSize[1] >= 480);
  window.webContents.emit('did-start-navigation', {}, window.webContents.url, false, true);
  assert.equal(f.calls.some((entry) => entry[0] === 'renderer-lost'), false,
    'initial navigation is not a lifecycle loss');
  window.webContents.emit('did-finish-load');
  window.webContents.emit('did-start-navigation', {}, window.webContents.url, false, true);
  window.webContents.emit('render-process-gone');
  window.webContents.emit('destroyed');
  assert.deepEqual(f.calls.filter((entry) => entry[0] === 'renderer-lost'), [
    ['renderer-lost', 'navigation'],
  ]);
});

test('a crashed visible control renderer is destroyed and recreated once', () => {
  const f = fixture();
  const first = f.shell.createWindow();
  first.webContents.emit('render-process-gone');
  const second = f.shell.window;

  assert.notEqual(second, first);
  assert.equal(first.isDestroyed(), true);
  assert.equal(second.loadedFile, '/fixture/app/renderer/index.html');
  assert.deepEqual(f.calls.filter((entry) => entry[0] === 'renderer-lost'), [
    ['renderer-lost', 'render-process-gone'],
  ]);
  // Late events from the old renderer cannot invalidate the replacement.
  first.webContents.emit('destroyed');
  assert.equal(f.shell.window, second);
  assert.equal(f.calls.filter((entry) => entry[0] === 'renderer-lost').length, 1);
});

test('repeated control renderer crashes trip a recovery circuit breaker', () => {
  let now = 100_000;
  const f = fixture({ now: () => now });
  const first = f.shell.createWindow();
  first.webContents.emit('render-process-gone');
  const recovery = f.shell.window;

  recovery.webContents.emit('render-process-gone');
  assert.equal(f.shell.window, null,
    'a recovery renderer that also crashes must not be recreated indefinitely');
  assert.deepEqual(f.calls.filter((entry) => entry[0] === 'error'), [
    ['error', 'error.controlRendererCrashLoop'],
  ]);

  now += 30_000;
  assert.equal(f.shell.showWindow(), true);
  const later = f.shell.window;
  later.webContents.emit('render-process-gone');
  assert.notEqual(f.shell.window, later,
    'a later isolated crash may receive one automatic recovery');
});

test('a crashed hidden renderer is recreated on the next show request', () => {
  const f = fixture();
  const first = f.shell.createWindow();
  first.visible = false;
  first.webContents.emit('render-process-gone');
  assert.equal(f.shell.window, null);
  assert.equal(f.shell.showWindow(), true);
  assert.notEqual(f.shell.window, first);
  assert.equal(f.shell.window.visible, true);
});

test('tray reflects connection state and delegates connect, browser and quit actions', async () => {
  const f = fixture();
  assert.equal(f.shell.createTray(), true);
  const template = f.shell.tray.menu;
  template[3].click();
  template[4].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.includes('connect'));
  assert.ok(f.calls.includes('browser'));
  assert.match(f.shell.tray.tooltip, /status\.disconnected/);
});

test('close prompt remembers minimize and keeps one prompt in flight', async () => {
  const f = fixture({
    dialog: {
      showMessageBox: async () => ({ response: 0, checkboxChecked: true }),
    },
  });
  const window = f.shell.createWindow();
  let prevented = false;
  await f.shell.handleWindowClose({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(f.calls.find((entry) => Array.isArray(entry) && entry[0] === 'remember'), [
    'remember', 'minimize',
  ]);
  assert.equal(window.visible, false);
});

test('quit disposes recovery, stops the Engine, cleans secrets and destroys tray once', async () => {
  const f = fixture();
  f.shell.createTray();
  const operation = f.shell.requestQuit();
  assert.equal(f.shell.requestQuit(), operation);
  await operation;
  assert.deepEqual(f.calls.filter((entry) => typeof entry === 'string'), [
    'dispose', 'disconnect', 'cleanup', 'quit',
  ]);
  assert.equal(f.shell.quitAllowed, true);
  assert.equal(f.shell.tray, null);
});

test('native close cancellation finishes before application quit begins', async () => {
  let nativeClosePending = true;
  const quitStates = [];
  const f = fixture({ getCloseAction: () => 'quit' });
  f.app.quit = () => quitStates.push({ nativeClosePending, allowed: f.shell.quitAllowed });
  const nativeDispatchFinished = new Promise((resolve) => setImmediate(() => {
    nativeClosePending = false;
    resolve();
  }));
  let prevented = false;
  const closeHandled = f.shell.handleWindowClose({ preventDefault() { prevented = true; } });
  const operation = f.shell.quitInFlight;
  assert.equal(f.shell.requestQuit(), operation, 'another quit joins the existing cleanup');
  await closeHandled;
  await operation;
  await nativeDispatchFinished;
  assert.equal(prevented, true);
  assert.deepEqual(quitStates, [{ nativeClosePending: false, allowed: true }]);
  assert.deepEqual(f.calls, ['dispose', 'disconnect', 'cleanup']);
});
