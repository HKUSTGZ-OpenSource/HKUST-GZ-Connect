'use strict';

// Retired Sessions retain a deny-only listener, never a reference to an old owner.
const sessionBindings = new WeakMap();
function denyDownload(event, item) {
  if (typeof event?.preventDefault === 'function') event.preventDefault();
  else { try { item.cancel(); } catch {} }
}

// Download state and native DownloadItem callbacks have one owner. Browser
// composition supplies current UI effects without routing or credential access.
class BrowserDownloadController {
  constructor({ getDialog, getWindow, getOnError, t, showItemInFolder, onStateChanged }) {
    this.getDialog = getDialog;
    this.getWindow = getWindow;
    this.getOnError = getOnError;
    this.t = t;
    this.showItemInFolder = showItemInFolder;
    this.scheduleToolbarUpdate = onStateChanged;
    this.downloadSessions = new Set();
    this.downloadState = null;
    this.visibleDownload = null;
    this.activeItems = new Map();
    this.retired = false;
  }

  get dialog() { return this.getDialog(); }
  get window() { return this.getWindow(); }
  get onError() { return this.getOnError(); }

  // Configure the native save picker and listeners during will-download.
  applyDownloadHandler(routeSession) {
    if (this.retired || typeof routeSession.on !== 'function' || this.downloadSessions.has(routeSession)) {
      return;
    }
    sessionBindings.get(routeSession)?.owner?.retire();
    const previous = sessionBindings.get(routeSession);
    if (previous) routeSession.removeListener('will-download', previous.handler);
    const handler = (event, item) => this.retired ? denyDownload(event, item) : this.handleDownload(item);
    sessionBindings.set(routeSession, { owner: this, handler });
    this.downloadSessions.add(routeSession);
    routeSession.on('will-download', handler);
  }

  retire() {
    if (this.retired) return;
    this.retired = true;
    for (const routeSession of this.downloadSessions) {
      const binding = sessionBindings.get(routeSession);
      if (binding?.owner !== this) continue;
      routeSession.removeListener('will-download', binding.handler);
      routeSession.on('will-download', denyDownload);
      sessionBindings.set(routeSession, { handler: denyDownload });
    }
    this.downloadSessions.clear();
    for (const [item, detach] of this.activeItems) {
      detach();
      // A state callback may retire us inside Chromium's updated observer.
      // Cancel after that native observer unwinds, while all JS effects are fenced now.
      setImmediate(() => { try { item.cancel(); } catch {} });
    }
    this.activeItems.clear();
    this.visibleDownload = null;
    this.downloadState = null;
  }

  handleDownload(item) {
    if (this.retired) { try { item?.cancel(); } catch {} return; }
    if (typeof item?.setSaveDialogOptions !== 'function') {
      try { item.cancel(); } catch {}
      return;
    }
    try {
      const downloadWindow = this.window;
      // Electron owns the asynchronous user choice. setSavePath and
      // setSaveDialogOptions must not be called after awaiting a custom dialog.
      item.setSaveDialogOptions({ defaultPath: item.getFilename() });
      const filename = String(item.getFilename() || '').slice(0, 160);
      const token = {};
      let finished = false;
      const updateProgress = () => {
        if (finished || this.retired) return;
        const total = Number(item.getTotalBytes?.());
        const received = Number(item.getReceivedBytes?.());
        const percent = Number.isFinite(total) && total > 0 && Number.isFinite(received)
          ? Math.max(0, Math.min(100, Math.round(received * 100 / total))) : null;
        this.visibleDownload = token;
        this.downloadState = Object.freeze({ filename, status: 'downloading', percent });
        this.scheduleToolbarUpdate();
      };
      const detach = () => {
        finished = true;
        item.removeListener?.('updated', updateProgress);
        item.removeListener?.('done', onDone);
        this.activeItems.delete(item);
      };
      const onDone = async (_event, state) => {
        if (finished || this.retired) return;
        detach();
        if (state === 'cancelled') {
          if (this.visibleDownload === token) {
            this.visibleDownload = null;
            this.downloadState = null;
            this.scheduleToolbarUpdate();
          }
          return;
        }
        this.visibleDownload = token;
        this.downloadState = Object.freeze({
          filename,
          status: state === 'completed' ? 'completed' : 'interrupted',
          percent: state === 'completed' ? 100 : null,
        });
        this.scheduleToolbarUpdate();
        if (this.retired) return;
        if (state === 'interrupted' && this.onError) {
          this.onError(this.t('download.interrupted', { filename }));
        }
        if (state === 'completed' && downloadWindow && this.window === downloadWindow &&
            !downloadWindow.isDestroyed?.() && typeof this.dialog?.showMessageBox === 'function') {
          try {
            // Cache before awaiting: DownloadItem may be destroyed after done.
            const filePath = item.getSavePath();
            if (typeof filePath !== 'string' || !filePath) throw new Error('download save path unavailable');
            const promptWindow = this.window;
            const prompt = await this.dialog.showMessageBox(promptWindow, {
              type: 'info',
              message: this.t('download.completed', { filename }),
              buttons: [this.t('download.showInFolder'), this.t('common.close')],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            });
            if (!this.retired && this.window === promptWindow && !promptWindow?.isDestroyed?.() &&
                prompt.response === 0) this.showItemInFolder(filePath);
          } catch {}
        }
      };
      this.activeItems.set(item, detach);
      item.on?.('updated', updateProgress);
      item.once('done', onDone);
      updateProgress();
    } catch {
      // Invalid native setup fails closed without creating a second picker.
      // A reentrant retirement already owns exactly one deferred cancellation.
      if (this.retired) return;
      this.activeItems.get(item)?.();
      try { item.cancel(); } catch {}
      if (!this.retired && this.onError) this.onError(this.t('download.noLocation'));
    }
  }

}

module.exports = { BrowserDownloadController };
