'use strict';

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
  }

  get dialog() { return this.getDialog(); }
  get window() { return this.getWindow(); }
  get onError() { return this.getOnError(); }

  // Electron would otherwise silently drop downloads because the campus
  // sessions have no default download behavior wired to a dialog.
  applyDownloadHandler(routeSession) {
    if (typeof routeSession.on !== 'function' || this.downloadSessions.has(routeSession)) {
      return;
    }
    this.downloadSessions.add(routeSession);
    routeSession.on('will-download', (_event, item) => this.handleDownload(item));
  }

  handleDownload(item) {
    if (typeof item?.setSaveDialogOptions !== 'function') {
      try { item.cancel(); } catch {}
      return;
    }
    try {
      item.setSaveDialogOptions({ defaultPath: item.getFilename() });
      const filename = String(item.getFilename() || '').slice(0, 160);
      let finished = false;
      const updateProgress = () => {
        if (finished) return;
        const total = Number(item.getTotalBytes?.());
        const received = Number(item.getReceivedBytes?.());
        const percent = Number.isFinite(total) && total > 0 && Number.isFinite(received)
          ? Math.max(0, Math.min(100, Math.round(received * 100 / total))) : null;
        this.downloadState = Object.freeze({ filename, status: 'downloading', percent });
        this.scheduleToolbarUpdate();
      };
      item.on?.('updated', updateProgress);
      updateProgress();
      item.once('done', async (_event, state) => {
        if (finished) return;
        finished = true;
        item.removeListener?.('updated', updateProgress);
        if (state === 'cancelled') {
          this.downloadState = null;
          this.scheduleToolbarUpdate();
          return;
        }
        this.downloadState = Object.freeze({
          filename,
          status: state === 'completed' ? 'completed' : 'interrupted',
          percent: state === 'completed' ? 100 : null,
        });
        this.scheduleToolbarUpdate();
        if (state === 'interrupted' && this.onError) {
          this.onError(this.t('download.interrupted', { filename }));
        }
        if (state === 'completed' && typeof this.dialog?.showMessageBox === 'function') {
          try {
            const filePath = item.getSavePath?.();
            const prompt = await this.dialog.showMessageBox(this.window, {
              type: 'info',
              message: this.t('download.completed', { filename }),
              buttons: [this.t('download.showInFolder'), this.t('common.close')],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            });
            if (prompt.response === 0 && typeof filePath === 'string' && filePath) {
              this.showItemInFolder(filePath);
            }
          } catch {}
        }
      });
    } catch {
      try { item.cancel(); } catch {}
      if (this.onError) this.onError(this.t('download.noLocation'));
    }
  }

}

module.exports = { BrowserDownloadController };
