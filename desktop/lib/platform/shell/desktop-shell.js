'use strict';

const path = require('node:path');
const { loadTrayImage } = require('./tray-icon');
const { CONTROL_WINDOW, clampWindowSize } = require('./window-layout');

// A transient Chromium renderer failure may be recovered once, but a broken
// preload/renderer must never turn into an unbounded create-crash-create loop.
// Keep the main/tray process alive so the user can retry after the underlying
// condition changes.
const CONTROL_RENDERER_RECOVERY_WINDOW_MS = 30_000;

class DesktopShell {
  constructor({
    app,
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    dialog,
    baseDirectory,
    controlRendererFile,
    preloadFile,
    platform,
    translate,
    getConnectionState,
    getCloseAction,
    connect,
    disconnect,
    openCampusBrowser,
    rememberCloseAction,
    disposeLifecycle,
    cleanupQuit,
    onControlRendererUnavailable,
    onWindowError,
    now = Date.now,
  } = {}) {
    for (const dependency of [
      BrowserWindow, Tray, translate, getConnectionState, getCloseAction, connect, disconnect,
      openCampusBrowser, rememberCloseAction, disposeLifecycle, cleanupQuit,
      onControlRendererUnavailable, onWindowError, now,
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('desktop shell dependencies are incomplete');
      }
    }
    if (!app || !Menu || !nativeImage || !dialog ||
        !path.isAbsolute(baseDirectory || '') ||
        !path.isAbsolute(controlRendererFile || '') || !path.isAbsolute(preloadFile || '')) {
      throw new TypeError('desktop shell environment is incomplete');
    }
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.Tray = Tray;
    this.Menu = Menu;
    this.nativeImage = nativeImage;
    this.dialog = dialog;
    this.baseDirectory = baseDirectory;
    this.controlRendererFile = controlRendererFile;
    this.preloadFile = preloadFile;
    this.platform = platform;
    this.translate = translate;
    this.getConnectionState = getConnectionState;
    this.getCloseAction = getCloseAction;
    this.connect = connect;
    this.disconnect = disconnect;
    this.openCampusBrowser = openCampusBrowser;
    this.rememberCloseAction = rememberCloseAction;
    this.disposeLifecycle = disposeLifecycle;
    this.cleanupQuit = cleanupQuit;
    this.onControlRendererUnavailable = onControlRendererUnavailable;
    this.onWindowError = onWindowError;
    this.now = now;
    this.window = null;
    this.windowInvalid = false;
    this.tray = null;
    this.isQuitting = false;
    this.quitAllowed = false;
    this.quitInFlight = null;
    this.closePromptOpen = false;
    this.lastAutomaticRendererRecoveryAt = null;
  }

  get webContents() {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }

  send(channel, payload) {
    const contents = this.webContents;
    if (!contents) return false;
    contents.send(channel, payload);
    return true;
  }

  isVisible() {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  showWindow() {
    if (!this.app.isReady()) return false;
    if (this.windowInvalid && this.window && !this.window.isDestroyed()) {
      const invalid = this.window;
      this.window = null;
      try { invalid.destroy(); } catch {}
    }
    if (!this.window || this.window.isDestroyed()) this.createWindow();
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    return true;
  }

  updateTray() {
    if (!this.tray || this.tray.isDestroyed()) return false;
    const state = this.getConnectionState();
    const status = state.connecting
      ? this.translate('status.connecting')
      : state.connected
        ? this.translate('status.connected')
        : this.translate('status.disconnected');
    this.tray.setToolTip(`HKUST(GZ) Connect - ${status}`);
    this.tray.setContextMenu(this.Menu.buildFromTemplate([
      { label: this.translate('tray.showWindow'), click: () => this.showWindow() },
      { label: this.translate('tray.status', { status }), enabled: false },
      { type: 'separator' },
      {
        label: state.connected
          ? this.translate('tray.disconnect')
          : this.translate('tray.connect'),
        enabled: !state.connecting,
        click: () => {
          const operation = state.connected ? this.disconnect() : this.connect();
          Promise.resolve(operation).catch(() => {});
        },
      },
      {
        label: this.translate('tray.openCampusBrowser'),
        click: () => { this.openCampusBrowser(); },
      },
      { type: 'separator' },
      { label: this.translate('tray.quit'), click: () => this.requestQuit() },
    ]));
    return true;
  }

  createTray() {
    if (this.tray && !this.tray.isDestroyed()) return true;
    const iconName = this.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const image = loadTrayImage(
      this.nativeImage,
      path.join(this.baseDirectory, 'build', iconName),
      this.platform,
    );
    if (image.isEmpty()) return false;
    this.tray = new this.Tray(image);
    this.tray.on('double-click', () => this.showWindow());
    this.updateTray();
    return true;
  }

  hideToTray() {
    if (!this.createTray()) return false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    return true;
  }

  resize(height) {
    if (!Number.isFinite(height)) throw new TypeError('窗口尺寸无效');
    if (!this.window || this.window.isDestroyed()) return false;
    const [width] = this.window.getContentSize();
    const next = clampWindowSize(width, height);
    this.window.setContentSize(next.width, next.height);
    return true;
  }

  requestQuit() {
    if (this.quitAllowed) {
      this.app.quit();
      return null;
    }
    if (this.quitInFlight) return this.quitInFlight;
    this.isQuitting = true;
    this.disposeLifecycle();
    const operation = (async () => {
      try {
        await this.disconnect();
      } finally {
        await this.cleanupQuit();
        if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
        this.tray = null;
        // Finish the native close cancellation before starting application quit.
        await new Promise((resolve) => setImmediate(resolve));
        this.quitAllowed = true;
        this.app.quit();
      }
    })();
    this.quitInFlight = operation;
    operation.catch(this.onWindowError).finally(() => {
      if (this.quitInFlight === operation) this.quitInFlight = null;
    });
    return operation;
  }

  async handleWindowClose(event) {
    if (this.isQuitting) return;
    event.preventDefault();
    let action = 'ask';
    try { action = this.getCloseAction() || 'ask'; } catch {}
    if (action === 'quit') {
      this.requestQuit();
      return;
    }
    if (action === 'minimize') {
      this.hideToTray();
      return;
    }
    if (this.closePromptOpen || !this.window || this.window.isDestroyed()) return;
    this.closePromptOpen = true;
    try {
      const result = await this.dialog.showMessageBox(this.window, {
        type: 'question',
        title: this.translate('close.title'),
        message: this.translate('close.message'),
        detail: this.translate('close.detail'),
        buttons: [
          this.translate('close.minimize'),
          this.translate('close.quit'),
          this.translate('close.cancel'),
        ],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        checkboxLabel: this.translate('close.remember'),
        checkboxChecked: false,
      });
      if (result.response === 0) {
        if (result.checkboxChecked) await this.rememberCloseAction('minimize');
        this.hideToTray();
      } else if (result.response === 1) {
        if (result.checkboxChecked) await this.rememberCloseAction('quit');
        this.requestQuit();
      }
    } finally {
      this.closePromptOpen = false;
    }
  }

  createWindow() {
    const window = new this.BrowserWindow({
      ...CONTROL_WINDOW,
      resizable: true,
      fullscreenable: false,
      maximizable: false,
      title: 'HKUST(GZ) Connect',
      backgroundColor: '#ffffff',
      titleBarStyle: this.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 14, y: 12 },
      webPreferences: {
        preload: this.preloadFile,
        devTools: !this.app.isPackaged,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    this.windowInvalid = false;
    const contents = window.webContents;
    let rendererLoaded = false;
    let rendererUnavailable = false;
    const reportRendererUnavailable = (reason) => {
      if (rendererUnavailable) return false;
      rendererUnavailable = true;
      this.onControlRendererUnavailable(reason);
      return true;
    };
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('did-finish-load', () => {
      rendererLoaded = true;
      rendererUnavailable = false;
    });
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (rendererLoaded && isMainFrame !== false && !isInPlace) {
        reportRendererUnavailable('navigation');
      }
    });
    contents.on('render-process-gone', () => {
      reportRendererUnavailable('render-process-gone');
      if (this.window !== window || this.isQuitting) return;
      const wasVisible = window.isVisible();
      this.windowInvalid = true;
      this.window = null;
      try { window.destroy(); } catch {}
      if (!wasVisible || !this.app.isReady()) return;
      const observedAt = this.now();
      const previous = this.lastAutomaticRendererRecoveryAt;
      if (previous === null || observedAt - previous >= CONTROL_RENDERER_RECOVERY_WINDOW_MS) {
        this.lastAutomaticRendererRecoveryAt = observedAt;
        this.createWindow();
        return;
      }
      const error = new Error(this.translate('error.controlRendererCrashLoop'));
      error.code = 'CONTROL_RENDERER_CRASH_LOOP_BLOCKED';
      this.onWindowError(error);
    });
    contents.on('destroyed', () => {
      reportRendererUnavailable('destroyed');
    });
    window.loadFile(this.controlRendererFile);
    window.on('close', (event) => {
      this.handleWindowClose(event).catch(this.onWindowError);
    });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
    return window;
  }

  installApplicationMenu() {
    if (this.platform !== 'darwin') {
      this.Menu.setApplicationMenu(null);
      return;
    }
    this.Menu.setApplicationMenu(this.Menu.buildFromTemplate([
      {
        label: 'HKUST(GZ) Connect',
        submenu: [
          { role: 'about', label: this.translate('menu.about') },
          { type: 'separator' },
          { role: 'hide', label: this.translate('menu.hide') },
          { role: 'hideOthers', label: this.translate('menu.hideOthers') },
          { role: 'unhide', label: this.translate('menu.unhide') },
          { type: 'separator' },
          { role: 'quit', label: this.translate('menu.quit') },
        ],
      },
      {
        label: this.translate('menu.edit'),
        submenu: [
          { role: 'undo', label: this.translate('menu.undo') },
          { role: 'redo', label: this.translate('menu.redo') },
          { type: 'separator' },
          { role: 'cut', label: this.translate('menu.cut') },
          { role: 'copy', label: this.translate('menu.copy') },
          { role: 'paste', label: this.translate('menu.paste') },
          { role: 'selectAll', label: this.translate('menu.selectAll') },
        ],
      },
      {
        label: this.translate('menu.window'),
        submenu: [
          { role: 'minimize', label: this.translate('menu.minimize') },
          { role: 'close', label: this.translate('menu.closeWindow') },
        ],
      },
    ]));
  }
}

module.exports = { DesktopShell };
