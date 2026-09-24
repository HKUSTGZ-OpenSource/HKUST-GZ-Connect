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
    assert.deepEqual(download.saveOptions, { defaultPath: 'fixture.txt' });
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
  value.setSaveDialogOptions = options => { value.saveOptions = options; };
  value.getSavePath = () => '/tmp/synthetic-download.txt';
  value.getTotalBytes = () => value.total;
  value.getReceivedBytes = () => value.received;
  return value;
}

function owner(dialog) {
  const errors = [], states = [], shown = [];
  let window = { isDestroyed: () => false };
  const controller = new BrowserDownloadController({
    getDialog: () => dialog, getWindow: () => window,
    getOnError: () => message => errors.push(message),
    t: (key, vars) => `${key}:${vars?.filename || ''}`,
    showItemInFolder: file => shown.push(file), onStateChanged: () => states.push(controller.downloadState),
  });
  return { controller, errors, states, shown, closeWindow: () => { window = null; },
    replaceWindow: () => { window = { isDestroyed: () => false }; } };
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
  assert.equal(download.listenerCount('updated'), 0);
  download.emit('updated');
  assert.equal(fixture.controller.downloadState.status, 'interrupted');
});

test('native cancellation is quiet and failed setup cancels the item', () => {
  const cancelled = item();
  const fixture = owner({});
  fixture.closeWindow();
  fixture.controller.handleDownload(cancelled);
  assert.deepEqual(cancelled.saveOptions, { defaultPath: 'fixture.txt' });
  cancelled.emit('done', {}, 'cancelled');
  assert.equal(fixture.controller.downloadState, null);
  assert.deepEqual(fixture.errors, []);
  const failed = owner({});
  const download = item();
  download.setSaveDialogOptions = () => { throw new Error('synthetic setup failure'); };
  failed.controller.handleDownload(download);
  assert.equal(download.cancelled, true);
  assert.deepEqual(failed.errors, ['download.noLocation:']);
});

test('completion caches the native path before its asynchronous prompt', async () => {
  let finishPrompt;
  const fixture = owner({ showSaveDialog: () => {}, showMessageBox: () => new Promise(resolve => { finishPrompt = resolve; }) });
  const download = item();
  await fixture.controller.handleDownload(download);
  download.emit('done', {}, 'completed');
  download.getSavePath = () => { throw new Error('native item destroyed'); };
  finishPrompt({ response: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.shown, ['/tmp/synthetic-download.txt']);
  assert.equal(download.listenerCount('updated'), 0);
});

test('cancelling an older item does not clear another download presentation', async () => {
  const fixture = owner({ showSaveDialog: () => {} });
  const first = item('first.txt'), second = item('second.txt');
  await fixture.controller.handleDownload(first);
  await fixture.controller.handleDownload(second);
  first.emit('done', {}, 'cancelled');
  assert.equal(fixture.controller.downloadState.filename, 'second.txt');
  second.emit('done', {}, 'cancelled');
  assert.equal(fixture.controller.downloadState, null);
});

test('retirement cancels active items once and fences queued callbacks and old Sessions', async () => {
  const fixture = owner({ showSaveDialog: () => {} });
  const session = new EventEmitter(), download = item();
  fixture.controller.applyDownloadHandler(session);
  session.emit('will-download', {}, download);
  const queued = download.listeners('updated')[0];
  let cancellations = 0;
  download.cancel = () => { cancellations += 1; download.emit('done', {}, 'cancelled'); };
  const stateCount = fixture.states.length;
  fixture.controller.retire();
  fixture.controller.retire();
  queued();
  download.emit('done', {}, 'interrupted');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(download.listenerCount('updated'), 0);
  assert.equal(download.listenerCount('done'), 0);
  assert.equal(fixture.controller.activeItems.size, 0);
  assert.equal(fixture.controller.downloadSessions.size, 0);
  assert.equal(fixture.controller.downloadState, null);
  assert.equal(fixture.states.length, stateCount);
  assert.deepEqual(fixture.errors, []);
  let prevented = false;
  session.emit('will-download', { preventDefault: () => { prevented = true; } }, item());
  assert.equal(prevented, true);
  const late = item();
  await fixture.controller.handleDownload(late);
  assert.equal(late.cancelled, true);
});

test('new Session owner replaces the retired deny listener without old-owner interference', async () => {
  const first = owner({ showSaveDialog: () => {} }), second = owner({ showSaveDialog: () => {} });
  const session = new EventEmitter(), download = item();
  first.controller.applyDownloadHandler(session);
  session.emit('will-download', {}, download);
  second.controller.applyDownloadHandler(session);
  first.controller.retire();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(download.cancelled, true);
  assert.equal(session.listenerCount('will-download'), 1);
  const next = item('next.txt');
  session.emit('will-download', {}, next);
  assert.equal(second.controller.downloadState.filename, 'next.txt');
  assert.equal(next.cancelled, undefined);
  second.controller.retire();
});

test('completion prompt cannot reveal a path after retirement or window replacement', async () => {
  for (const invalidate of [f => f.controller.retire(), f => f.closeWindow()]) {
    let resolvePrompt;
    const fixture = owner({ showSaveDialog: () => {}, showMessageBox: () => new Promise(resolve => { resolvePrompt = resolve; }) });
    const download = item();
    await fixture.controller.handleDownload(download);
    download.emit('done', {}, 'completed');
    invalidate(fixture);
    resolvePrompt({ response: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.shown, []);
  }
});

test('initial presentation can retire reentrantly without leaking native listeners', async () => {
  const fixture = owner({ showSaveDialog: () => {} });
  fixture.controller.scheduleToolbarUpdate = () => fixture.controller.retire();
  const download = item();
  await fixture.controller.handleDownload(download);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(download.cancelled, true);
  assert.equal(download.listenerCount('updated'), 0);
  assert.equal(download.listenerCount('done'), 0);
  assert.equal(fixture.controller.activeItems.size, 0);
});

test('ordinary window closure leaves native progress alive', async () => {
  const fixture = owner({ showSaveDialog: () => {} });
  const download = item();
  await fixture.controller.handleDownload(download);
  fixture.closeWindow();
  download.total = 100; download.received = 30; download.emit('updated');
  assert.equal(fixture.controller.downloadState.percent, 30);
  assert.equal(download.cancelled, undefined);
  fixture.controller.retire();
});

test('an old download cannot open a completion prompt in a closed or replacement window', async () => {
  for (const invalidate of [f => f.closeWindow(), f => f.replaceWindow()]) {
    let prompts = 0;
    const fixture = owner({ showSaveDialog: () => {},
      showMessageBox: async () => { prompts += 1; return { response: 0 }; } });
    const download = item();
    await fixture.controller.handleDownload(download);
    invalidate(fixture);
    download.emit('done', {}, 'completed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompts, 0);
    assert.deepEqual(fixture.shown, []);
  }
});

test('completion keeps the user choice explicit', async () => {
  const fixture = owner({ showSaveDialog: () => {}, showMessageBox: async () => ({ response: 1 }) });
  const download = item();
  await fixture.controller.handleDownload(download);
  download.emit('done', {}, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.shown, []);
  assert.equal(fixture.controller.downloadState.status, 'completed');
});

test('retirement followed by a presentation error still cancels once', async () => {
  const fixture = owner({ showSaveDialog: () => {} });
  const download = item();
  let cancellations = 0;
  download.cancel = () => { cancellations += 1; };
  fixture.controller.scheduleToolbarUpdate = () => {
    fixture.controller.retire();
    throw new Error('synthetic presentation failure');
  };
  await fixture.controller.handleDownload(download);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(fixture.controller.activeItems.size, 0);
  assert.deepEqual(fixture.errors, []);
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
  assert.deepEqual(download.saveOptions, { defaultPath: 'fast.pdf' });
  assert.equal(download.listenerCount('done'), 1);
  download.emit('done', {}, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.controller.downloadState,
    { filename: 'fast.pdf', status: 'completed', percent: 100 });
});
