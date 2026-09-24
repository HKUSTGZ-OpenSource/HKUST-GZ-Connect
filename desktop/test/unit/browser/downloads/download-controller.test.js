'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { BrowserDownloadController } = require('../../../../lib/browser/downloads/download-controller');

test('download owner remains within the Browser owner budget', () => {
  const source = fs.readFileSync(require.resolve('../../../../lib/browser/downloads/download-controller'), 'utf8');
  assert(source.trimEnd().split('\n').length <= 600);
  const browser = fs.readFileSync(require.resolve('../../../../lib/browser/session/campus-browser'), 'utf8');
  assert(browser.trimEnd().split('\n').length <= 1804);
  assert(!browser.includes('item.setSavePath('));
  assert(!browser.includes("item.once('done'"));
});

test('completion reveals only the selected path after an explicit prompt choice', async () => {
  for (const response of [0, 1]) {
    const revealed = [];
    const fixture = owner({
      showMessageBox: async () => ({ response }),
    });
    fixture.controller.showItemInFolder = path => revealed.push(path);
    const download = item();
    fixture.controller.handleDownload(download);
    assert.deepEqual(download.saveDialogOptions, { defaultPath: 'fixture.txt' });
    download.emit('done', {}, 'completed');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(revealed, response === 0 ? ['/tmp/synthetic-download.txt'] : []);
    assert.deepEqual(fixture.controller.downloadState,
      { filename: 'fixture.txt', status: 'completed', percent: 100 });
  }
});

test('injected effects read the current browser locale and window at call time', async () => {
  let locale = 'zh';
  let window = { id: 'original' };
  const calls = [];
  const controller = new BrowserDownloadController({
    getDialog: () => ({
      showMessageBox: async (parent, options) => { calls.push(parent, options.message); return { response: 1 }; },
    }),
    getWindow: () => window, getOnError: () => null,
    t: key => `${locale}:${key}`, showItemInFolder: () => {}, onStateChanged: () => {},
  });
  locale = 'en';
  window = { id: 'current' };
  const download = item();
  controller.handleDownload(download);
  download.emit('done', {}, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [window, 'en:download.completed']);
});

function item(filename = 'fixture.txt') {
  const value = new EventEmitter();
  value.getFilename = () => filename;
  value.cancel = () => { value.cancelled = true; };
  value.setSaveDialogOptions = options => { value.saveDialogOptions = options; };
  value.getSavePath = () => '/tmp/synthetic-download.txt';
  value.getTotalBytes = () => value.total;
  value.getReceivedBytes = () => value.received;
  return value;
}

function owner(dialog) {
  const errors = [], states = [];
  let window = { isDestroyed: () => false };
  const controller = new BrowserDownloadController({
    getDialog: () => dialog, getWindow: () => window,
    getOnError: () => message => errors.push(message),
    t: (key, vars) => `${key}:${vars?.filename || ''}`,
    showItemInFolder: () => {}, onStateChanged: () => states.push(controller.downloadState),
  });
  return { controller, errors, states, closeWindow: () => { window = null; } };
}

test('download ownership deduplicates sessions and bounds presentation progress', () => {
  const fixture = owner({});
  const session = new EventEmitter();
  fixture.controller.applyDownloadHandler(session);
  fixture.controller.applyDownloadHandler(session);
  assert.equal(session.listenerCount('will-download'), 1);
  const download = item('x'.repeat(200));
  fixture.controller.handleDownload(download);
  assert.equal(fixture.controller.downloadState.filename.length, 160);
  assert.equal(fixture.controller.downloadState.percent, null);
  download.total = 100; download.received = 140; download.emit('updated');
  assert.equal(fixture.controller.downloadState.percent, 100);
  download.received = -20; download.emit('updated');
  assert.equal(fixture.controller.downloadState.percent, 0);
  assert(Object.isFrozen(fixture.controller.downloadState));
  download.emit('done', {}, 'interrupted');
  assert.equal(fixture.controller.downloadState.status, 'interrupted');
  assert.equal(fixture.errors.length, 1);
});

test('native save cancellation clears progress and setup errors cancel safely', () => {
  const cancelled = item();
  const fixture = owner({});
  fixture.closeWindow();
  fixture.controller.handleDownload(cancelled);
  cancelled.emit('done', {}, 'cancelled');
  assert.equal(fixture.controller.downloadState, null);
  const failed = owner({});
  const download = item();
  download.setSaveDialogOptions = () => { throw new Error('synthetic native setup failure'); };
  failed.controller.handleDownload(download);
  assert.equal(download.cancelled, true);
  assert.deepEqual(failed.errors, ['download.noLocation:']);
});

test('fast downloads attach native completion before will-download returns', async () => {
  const fixture = owner({
    showSaveDialog: () => assert.fail('a custom asynchronous save dialog must not run'),
    showMessageBox: async () => ({ response: 1 }),
  });
  const session = new EventEmitter();
  fixture.controller.applyDownloadHandler(session);
  const download = item('fast.pdf');
  download.total = 100; download.received = 100;
  session.emit('will-download', {}, download);
  assert.deepEqual(download.saveDialogOptions, { defaultPath: 'fast.pdf' });
  assert.equal(download.listenerCount('done'), 1);
  download.emit('done', {}, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.controller.downloadState,
    { filename: 'fast.pdf', status: 'completed', percent: 100 });
});
