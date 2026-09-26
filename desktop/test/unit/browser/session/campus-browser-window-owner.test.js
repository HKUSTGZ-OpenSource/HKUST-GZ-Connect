'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { CampusBrowserWindowOwner } = require('../../../../lib/browser/session/campus-browser-manager');

class FakeBrowserWindow extends EventEmitter {
  constructor(options, behavior = {}) {
    super();
    this.options = options;
    this.behavior = behavior;
    this.destroyed = false;
    this.loadCalls = [];
    this.closeCalls = 0;
    this.webContents = new EventEmitter();
  }

  async loadFile(file, options) {
    this.loadCalls.push({ file, options });
    return this.behavior.loadFile?.(this, file, options);
  }

  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  show() { this.showCalls = (this.showCalls || 0) + 1; }
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  restore() {}

  close() {
    this.closeCalls++;
    if (typeof this.behavior.close === 'function') return this.behavior.close(this);
    this.destroyed = true;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createOwner(options = {}) {
  const windows = [];
  const commands = [];
  const resized = [];
  const closed = [];
  const missingWindowCleanup = [];
  let owner;
  owner = new CampusBrowserWindowOwner({
    BrowserWindow: class extends FakeBrowserWindow {
      constructor(windowOptions) {
        super(windowOptions, options.windowBehavior);
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
    onBeforeCreate: () => options.onBeforeCreate?.(),
    onClosed: window => {
      closed.push({ window, duringTeardown: owner.window });
      options.onClosed?.(window, owner);
    },
    onMissingWindow: () => {
      missingWindowCleanup.push(true);
      options.onMissingWindow?.(owner);
    },
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

test('window retirement is installed before toolbar loading and rejects late readiness', async (t) => {
  const loading = deferred();
  const { owner, windows, closed } = createOwner({
    windowBehavior: {
      loadFile: () => loading.promise,
      close: (window) => { window.destroyed = true; window.emit('closed'); },
    },
  });
  const creation = owner.createWindow().then(
    value => ({ value }),
    error => ({ error }),
  );
  const window = windows[0];
  t.after(async () => {
    loading.resolve();
    await creation;
  });

  assert.equal(window.listenerCount('closed'), 1,
    'native retirement must be observed before loadFile can settle');
  window.close();
  assert.equal(owner.window, null);
  assert.deepEqual(closed, [{ window, duringTeardown: window }]);

  loading.resolve();
  const result = await creation;
  assert.ok(result.error, 'a closed in-flight window cannot become ready later');
  assert.equal(window.webContents.listenerCount('ipc-message'), 0);
  assert.equal(window.listenerCount('resize'), 0);
});

test('loadFile rejection requests close and retires only after the owned close is confirmed', async () => {
  const loadError = new Error('synthetic toolbar load failure');
  const { owner, windows, closed } = createOwner({
    windowBehavior: {
      loadFile: () => Promise.reject(loadError),
      close: (window) => { window.destroyed = true; window.emit('closed'); },
    },
  });
  const creation = owner.createWindow().then(
    value => ({ value }),
    error => ({ error }),
  );

  const result = await creation;
  const window = windows[0];
  assert.equal(window.closeCalls, 1);
  assert.equal(window.isDestroyed(), true);
  assert.equal(owner.window, null);
  assert.deepEqual(closed, [{ window, duringTeardown: window }]);
  assert.equal(result.error, loadError);
  assert.equal(window.webContents.listenerCount('ipc-message'), 0);
  assert.equal(window.listenerCount('resize'), 0);
});

test('an unconfirmed failed window remains the owner and blocks replacement', async () => {
  const loadError = new Error('synthetic toolbar load failure');
  const { owner, windows } = createOwner({
    windowBehavior: {
      loadFile: () => Promise.reject(loadError),
      close: () => {},
    },
  });
  await assert.rejects(owner.createWindow(), error => error === loadError);
  const failedWindow = windows[0];

  assert.equal(failedWindow.isDestroyed(), false);
  assert.equal(owner.window, failedWindow,
    'without native close confirmation the failed record remains a fail-closed owner');
  await assert.rejects(owner.createWindow(), error => error === loadError);
  assert.deepEqual(windows, [failedWindow], 'unconfirmed native UI must block replacement');
});

test('a retired load cannot attach listeners to or clear its replacement', async () => {
  const firstLoad = deferred();
  let loadCount = 0;
  const { owner, windows, closed } = createOwner({
    windowBehavior: {
      loadFile: () => ++loadCount === 1 ? firstLoad.promise : undefined,
      close: (window) => { window.destroyed = true; window.emit('closed'); },
    },
  });
  const firstCreation = owner.createWindow().then(
    value => ({ value }),
    error => ({ error }),
  );
  const firstWindow = windows[0];
  firstWindow.close();
  const replacement = await owner.createWindow();
  firstLoad.resolve();
  const firstResult = await firstCreation;

  assert.equal(windows.length, 2);
  assert.equal(owner.window, replacement);
  assert.ok(firstResult.error, 'the retired caller cannot receive a ready old window');
  assert.equal(firstWindow.listenerCount('closed'), 0);
  assert.equal(firstWindow.listenerCount('resize'), 0);
  assert.equal(firstWindow.webContents.listenerCount('ipc-message'), 0);
  assert.equal(closed.length, 1, 'late completion cannot run cleanup against the replacement');
});

test('clear during a destroyed pending load prevents late listener installation', async () => {
  const loading = deferred();
  let loadCount = 0;
  const { owner, windows } = createOwner({
    windowBehavior: { loadFile: () => ++loadCount === 1 ? loading.promise : undefined },
  });
  const firstCreation = owner.createWindow().then(
    value => ({ value }),
    error => ({ error }),
  );
  const stale = windows[0];
  stale.destroyed = true;
  owner.clear();
  const replacement = await owner.createWindow();
  loading.resolve();
  const staleResult = await firstCreation;

  assert.equal(owner.window, replacement);
  assert.ok(staleResult.error, 'cleared creation must reject rather than return its old Window');
  assert.equal(stale.listenerCount('closed'), 0);
  assert.equal(stale.listenerCount('resize'), 0);
  assert.equal(stale.webContents.listenerCount('ipc-message'), 0);
});

test('window owner retires once and preserves teardown ordering', async () => {
  const { owner, closed } = createOwner();
  const window = await owner.createWindow();

  window.emit('closed');
  window.emit('closed');

  assert.equal(owner.window, null);
  assert.deepEqual(closed, [{ window, duringTeardown: window }]);
});

test('reentrant retirement cannot clear a replacement or run Browser cleanup twice', async () => {
  let firstWindow = null;
  let replacementCreation = null;
  const { owner, windows, closed, commands, resized } = createOwner({
    onClosed: (window, currentOwner) => {
      if (window === firstWindow) {
        window.emit('closed');
        replacementCreation = currentOwner.createWindow();
      }
    },
  });
  firstWindow = await owner.createWindow();
  firstWindow.emit('closed');
  const current = await replacementCreation;
  firstWindow.webContents.emit('ipc-message', {}, 'campus-toolbar-command', { command: 'reload' });
  firstWindow.emit('resize');

  assert.equal(owner.window, current);
  assert.equal(windows.length, 2);
  assert.equal(closed.length, 1, 'reentrant closed delivery cannot repeat retired cleanup');
  assert.deepEqual(commands, [], 'retired IPC cannot command the replacement');
  assert.deepEqual(resized, [], 'retired resize cannot lay out the replacement');

  current.emit('closed');
  assert.equal(owner.window, null);
  assert.deepEqual(closed.map(({ window }) => window), [firstWindow, current]);
});

test('failed Browser cleanup is distinct from physical close and blocks replacement', async () => {
  const cleanupError = new Error('synthetic Browser cleanup failure');
  let cleanupCalls = 0;
  const { owner, windows } = createOwner({
    onClosed: () => { cleanupCalls++; throw cleanupError; },
  });
  const window = await owner.createWindow();
  window.destroyed = true;

  assert.doesNotThrow(() => window.emit('closed'),
    'native event cleanup failures must not escape the async load task');
  assert.equal(owner.current.cleanupFailure, cleanupError,
    'the partial-cleanup cause remains available on its blocked record');
  assert.equal(owner.window, window,
    'physical close confirmation alone cannot release failed Browser cleanup ownership');
  assert.equal(owner.clear(), false, 'clear cannot bypass an incomplete Browser cleanup');
  await assert.rejects(owner.createWindow(), error => error === cleanupError);
  assert.equal(await owner.closeForContextSwitch(), false,
    'Profile switching cannot pass a failed Browser cleanup');
  assert.equal(cleanupCalls, 1, 'retirement never repeats a partially executed domain cleanup');
  assert.deepEqual(windows, [window]);
});

test('context-switch cleanup cannot reentrantly create a replacement before its barrier resolves', async () => {
  let replacementResult;
  let firstWindow;
  const { owner, windows } = createOwner({
    windowBehavior: {
      close: window => { window.destroyed = true; window.emit('closed'); },
    },
    onClosed: (window, currentOwner) => {
      if (window === firstWindow) {
        replacementResult = currentOwner.createWindow().then(
          replacement => ({ replacement }),
          error => ({ error }),
        );
      }
    },
  });
  firstWindow = await owner.createWindow();
  assert.equal(await owner.closeForContextSwitch(), true);
  const result = await replacementResult;

  assert.match(result.error.message, /cleanup|context|close/u);
  assert.equal(owner.window, null);
  assert.deepEqual(windows, [firstWindow]);
});

test('detach failure settles load waiters without an unhandled load task or replacement', async (t) => {
  const loading = deferred();
  const loadError = new Error('synthetic toolbar load failure');
  const browserCleanupError = new Error('synthetic Browser cleanup failure');
  const detachError = new Error('synthetic detach failure');
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const { owner, windows } = createOwner({
    windowBehavior: { loadFile: () => loading.promise },
    onClosed: () => { throw browserCleanupError; },
  });
  let result;
  const creation = owner.createWindow().then(
    window => { result = { window }; },
    error => { result = { error }; },
  );
  const window = windows[0];
  window.destroyed = true;
  window.removeListener = (event, listener) => {
    if (event === 'closed') throw detachError;
    return EventEmitter.prototype.removeListener.call(window, event, listener);
  };
  loading.reject(loadError);
  await Promise.race([creation, new Promise(resolve => setImmediate(resolve))]);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result, { error: loadError }, 'retirement failure still rejects ready waiters');
  assert.deepEqual(unhandled, [], 'the owner observes its internal load task rejection');
  assert.equal(owner.window, window, 'failed teardown remains current and fail closed');
  assert.match(owner.current.cleanupFailure.message, /detach failure/u);
  assert.deepEqual(owner.current.cleanupFailures, [detachError, browserCleanupError]);
  await assert.rejects(owner.createWindow(), /detach failure/u);
  assert.equal(windows.length, 1);
});

test('stale window events cannot clear, command, or resize a replacement', async () => {
  const { owner, windows, closed, commands, resized } = createOwner();
  const stale = await owner.createWindow();
  stale.emit('closed');
  const current = await owner.createWindow();
  stale.webContents.emit('ipc-message', {}, 'campus-toolbar-command', { command: 'reload' });
  stale.emit('resize');

  assert.equal(owner.window, current, 'a retired window cannot clear a replacement');
  assert.equal(closed.length, 1, 'a stale close cannot tear down replacement-owned resources');
  assert.deepEqual(commands, [], 'a stale window cannot dispatch toolbar commands');
  assert.deepEqual(resized, [], 'a stale window cannot schedule replacement layout');

  current.emit('closed');
  assert.deepEqual(windows, [stale, current]);
  assert.deepEqual(closed.map(({ window }) => window), [stale, current]);
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

  const { owner: unconfirmed, windows: unconfirmedWindows } = createOwner({
    windowBehavior: { close: () => {} },
  });
  await unconfirmed.createWindow();
  const liveWindow = unconfirmedWindows[0];
  const ownerCloseListeners = liveWindow.listenerCount('closed');
  assert.equal(ownerCloseListeners, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    let expire;
    const expired = unconfirmed.closeForContextSwitch({
      timeoutMs: 100,
      setTimeoutFn(callback) { expire = callback; return { unref() {} }; },
      clearTimeoutFn() {},
    });
    expire();
    assert.equal(await expired, false);
    assert.equal(liveWindow.listenerCount('closed'), ownerCloseListeners,
      'a deadline winner must remove its one-shot observer');
  }
  liveWindow.destroyed = true;
  liveWindow.emit('closed');
  assert.equal(unconfirmed.window, null);
  assert.equal(liveWindow.listenerCount('closed'), 0);
});

test('confirmed native close detaches the captured WebContents without rereading a destroyed window', async () => {
  const { owner, windows } = createOwner({
    windowBehavior: {
      close: window => { window.destroyed = true; window.emit('closed'); },
    },
  });
  const window = await owner.createWindow();
  const contents = window.webContents;
  Object.defineProperty(window, 'webContents', {
    configurable: true,
    get() {
      if (window.destroyed) throw new TypeError('Object has been destroyed');
      return contents;
    },
  });

  assert.equal(await owner.closeForContextSwitch(), true);
  assert.equal(owner.window, null);
  assert.equal(owner.current, null);
  assert.equal(contents.listenerCount('ipc-message'), 0);
  assert.deepEqual(windows, [window]);
});

test('context-switch close rejects invalid deadlines without touching the window', async () => {
  const { owner, windows } = createOwner();
  const window = await owner.createWindow();
  await assert.rejects(owner.closeForContextSwitch({ timeoutMs: 99 }), /deadline/u);
  assert.equal(windows.length, 1);
  assert.equal(window.closeCalls, 0);
});

test('context-switch close removes its observer when timer setup or native close throws', async () => {
  const { owner: timerFailure, windows: timerWindows } = createOwner();
  await timerFailure.createWindow();
  const timerWindow = timerWindows[0];
  assert.equal(await timerFailure.closeForContextSwitch({
    setTimeoutFn() { throw new Error('synthetic timer setup failure'); },
  }), false);
  assert.equal(timerWindow.listenerCount('closed'), 1,
    'timer setup failure removes only the temporary close observer');
  assert.equal(timerWindow.closeCalls, 0, 'deadline setup failure does not issue close');
  assert.match(timerFailure.current.closeFailure.message, /timer setup failure/u);

  const { owner: closeFailure, windows: closeWindows } = createOwner({
    windowBehavior: { close: () => { throw new Error('synthetic native close failure'); } },
  });
  await closeFailure.createWindow();
  const closeWindow = closeWindows[0];
  assert.equal(await closeFailure.closeForContextSwitch({
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn() {},
  }), false);
  assert.equal(closeWindow.listenerCount('closed'), 1,
    'native close failure removes its temporary close observer');
  assert.match(closeFailure.current.closeFailure.message, /native close failure/u);
});

test('a transient context close failure stays retired and permits only close retry', async () => {
  let closeCalls = 0;
  const { owner, windows } = createOwner({
    windowBehavior: {
      close: window => {
        closeCalls++;
        if (closeCalls === 1) throw new Error('synthetic transient close failure');
        window.destroyed = true;
        window.emit('closed');
      },
    },
  });
  const window = await owner.createWindow();
  const closeOptions = {
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn() {},
  };

  assert.equal(await owner.closeForContextSwitch(closeOptions), false);
  assert.equal(owner.contextRetired, true);
  await assert.rejects(owner.createWindow(), /not ready/u,
    'a failed context close cannot reopen or replace its window');
  assert.equal(await owner.closeForContextSwitch(closeOptions), true,
    'the existing context close operation remains retryable');
  assert.equal(closeCalls, 2);
  assert.equal(owner.window, null);
  assert.equal(owner.contextRetired, true, 'confirmed retry does not reactivate the retired owner');
  assert.deepEqual(windows, [window]);
  await assert.rejects(owner.createWindow(), /context is retired/u);
});

test('failed temporary close-observer removal retains the closed owner and blocks retries', async () => {
  const removeError = new Error('synthetic close observer removal failure');
  const { owner, windows } = createOwner({
    windowBehavior: {
      close: window => { window.destroyed = true; window.emit('closed'); },
    },
  });
  const window = await owner.createWindow();
  const retirementListener = window.listeners('closed')[0];
  const removeListener = window.removeListener.bind(window);
  window.removeListener = (event, listener) => {
    if (event === 'closed' && listener !== retirementListener) throw removeError;
    return removeListener(event, listener);
  };

  assert.equal(await owner.closeForContextSwitch(), false);
  assert.equal(owner.window, window,
    'observer removal failure must not release physical-close ownership');
  assert.equal(owner.current.closeObserverFailure, removeError);
  assert.equal(await owner.closeForContextSwitch(), false,
    'a repeated close cannot report success after observer retirement failed');
  await assert.rejects(owner.createWindow(), error => error === removeError);
  assert.equal(owner.clear(), false, 'clear cannot replace a record with failed observer cleanup');
  assert.deepEqual(windows, [window]);
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
