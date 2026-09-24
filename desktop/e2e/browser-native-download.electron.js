'use strict';

// Real DownloadItem, loopback-only payload and disposable profile. The first
// listener simulates a user-selected path synchronously so no OS dialog opens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { BrowserDownloadController } = require('../lib/browser/downloads/download-controller');

const profile = process.argv[2];
if (typeof profile !== 'string' || !path.isAbsolute(profile) ||
    path.dirname(profile) !== fs.realpathSync(os.tmpdir()) ||
    !/^hkustgz-download-native-[a-zA-Z0-9]+$/u.test(path.basename(profile)) ||
    fs.lstatSync(profile).isSymbolicLink() || !fs.lstatSync(profile).isDirectory()) {
  throw new Error('Native download fixture requires a Node-parent profile');
}
app.on('window-all-closed', () => {});
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
app.setPath('userData', profile);
app.disableHardwareAcceleration();

async function run() {
  await app.whenReady();
  const payload = Buffer.from('synthetic native download\n');
  const destination = path.join(profile, 'fixture.txt');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="fixture.txt"',
      'Content-Length': _request.url === '/retire' ? 1024 * 1024 : payload.length });
    if (_request.url === '/retire') { response.write(Buffer.alloc(64 * 1024, 65)); return; }
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pageSession = session.fromPartition(`synthetic-native-download-${process.pid}`);
  await pageSession.setProxy({ mode: 'direct' });
  const window = new BrowserWindow({ show: false, webPreferences: { session: pageSession,
    nodeIntegration: false, contextIsolation: true, sandbox: true } });
  let saveCalls = 0, nativeOptions = null, mode = 'complete', notifications = 0, retiredAt = null;
  const errors = [];
  let finished;
  const terminal = new Promise(resolve => { finished = resolve; });
  pageSession.on('will-download', (_event, item) => {
    item.setSavePath(mode === 'complete' ? destination : path.join(profile, `${mode}.txt`));
    item.once('done', (_event, state) => finished(state));
  });
  const controller = new BrowserDownloadController({
    getWindow: () => window,
    getDialog: () => ({
      showSaveDialog: async () => {
        saveCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { filePath: destination };
      },
      showMessageBox: async () => ({ response: 1 }),
    }),
    getOnError: () => message => errors.push(message),
    t: key => key, showItemInFolder: () => {}, onStateChanged: () => {
      notifications += 1;
      if (mode === 'retire' && controller.downloadState?.percent > 0) {
        retiredAt = notifications;
        controller.retire();
      }
    },
  });
  controller.applyDownloadHandler(pageSession);
  pageSession.on('will-download', (_event, item) => {
    nativeOptions = item.getSaveDialogOptions();
    if (mode === 'cancel') item.cancel();
  });
  let timer;
  try {
    window.webContents.downloadURL(`http://127.0.0.1:${server.address().port}/fixture`);
    const state = await Promise.race([terminal, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native download timed out')), 5000);
    })]);
    clearTimeout(timer);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(state, 'completed');
    assert.deepEqual(fs.readFileSync(destination), payload);
    assert.equal(controller.downloadState?.status, 'completed', 'owner missed the real native completion');
    assert.equal(saveCalls, 0, 'native download must not await a second asynchronous save picker');
    assert.equal(nativeOptions.defaultPath, 'fixture.txt');
    assert.deepEqual(errors, []);
    mode = 'cancel';
    const cancellation = new Promise(resolve => { finished = resolve; });
    window.webContents.downloadURL(`http://127.0.0.1:${server.address().port}/cancel`);
    const cancelled = await Promise.race([cancellation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native cancellation timed out')), 5000);
    })]);
    clearTimeout(timer);
    assert.equal(cancelled, 'cancelled');
    assert.equal(controller.downloadState, null);
    assert.deepEqual(errors, []);
    mode = 'retire';
    const retirement = new Promise(resolve => { finished = resolve; });
    window.webContents.downloadURL(`http://127.0.0.1:${server.address().port}/retire`);
    const retiredState = await Promise.race([retirement, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native retirement cancellation timed out')), 5000);
    })]);
    clearTimeout(timer);
    assert.equal(retiredState, 'cancelled');
    assert.notEqual(retiredAt, null, 'retirement must follow observed partial progress');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(notifications, retiredAt, 'retired owner must not notify the UI');
    assert.equal(controller.downloadState, null);
    assert.equal(controller.activeItems.size, 0);
    assert.equal(controller.downloadSessions.size, 0);
    assert.deepEqual(errors, []);
    console.log('native DownloadItem save timing and active retirement: PASS');
  } finally {
    clearTimeout(timer);
    controller.retire();
    window.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

run().then(() => app.exit(0)).catch(error => {
  console.error(error.stack || error.message);
  app.exit(1);
});
