'use strict';
const assert = require('node:assert/strict');

// sendInputEvent enters real Electron/Chromium input delivery. This does not
// claim physical keyboard input or replace the direct production-owner tests.
async function assertNativeNewTabKeyboard({ browser, preference, configuredUrl, waitForMain, waitForPage }) {
  const observations = [], initialTabs = new Set(browser.tabs);
  const workspace = browser.tabs.find(tab => tab.kind === 'workspace');
  assert.ok(workspace);
  const toolbar = browser.window.webContents;
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
  async function focus(contents, label) {
    browser.window.show(); browser.window.focus(); contents.focus();
    await waitForMain(() => contents.isFocused(), `${label} native focus`);
    await waitForPage(contents, 'document.hasFocus()', `${label} renderer focus`);
  }
  async function stroke(label, contents, { releaseOnly = false, expected = 1, releaseContents = null } = {}) {
    const record = { surface: label, releaseOnly, before: browser.tabs.length, events: [] };
    observations.push(record);
    const listeners = new Map();
    const watch = (target, surface) => {
      if (listeners.has(target)) return;
      const listener = (_event, input) => {
        if (String(input.key).toLowerCase() === 't') record.events.push({ surface, type: input.type });
      };
      listeners.set(target, listener); target.on('before-input-event', listener);
    };
    watch(contents, label);
    try {
      await focus(contents, label);
      if (!releaseOnly) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: process.platform === 'darwin' ? 'Meta' : 'Control' });
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers });
        await waitForMain(() => record.events.some(event => event.type === 'keyDown'), `${label} keyDown delivery`);
      }
      if (expected) await waitForMain(() => browser.tabs.length === record.before + expected &&
        browser.activeTab().view.webContents.getURL() === preference.url, `${label} configured tab destination`);
      const opened = expected ? browser.activeTab() : null;
      // Creation can detach the source. Transfer release to the newly selected
      // page and establish its native and renderer focus before sending input.
      const target = releaseContents || (expected ? opened.view.webContents : contents);
      watch(target, 'release');
      if (target !== contents) await focus(target, `${label} release`);
      target.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers });
      await waitForMain(() => record.events.some(event => event.type === 'keyUp'), `${label} keyUp delivery`);
      if (expected) await waitForMain(() => browser.tabs.length === record.before + expected &&
        browser.activeTab().view.webContents.getURL() === preference.url, `${label} configured tab destination`);
      target.sendInputEvent({ type: 'keyUp', keyCode: process.platform === 'darwin' ? 'Meta' : 'Control' });
      await new Promise(setImmediate);
      record.after = browser.tabs.length;
      assert.equal(record.after - record.before, expected, `${label} new-tab effect`);
      assert.equal(record.events.filter(event => event.type === 'keyDown').length, releaseOnly ? 0 : 1);
    } finally {
      for (const [target, listener] of listeners) target.removeListener('before-input-event', listener);
      process.stdout.write(`native new-tab input: ${JSON.stringify(record)}\n`);
    }
  }
  function restoreTabs() {
    for (const tab of [...browser.tabs]) if (!initialTabs.has(tab)) browser.closeTab(tab.id);
    browser.switchTab(workspace.id);
  }
  const originalPreference = preference.url, originalCapacity = browser.tabManager.canAdd, originalError = browser.onError;
  try {
    for (const destination of ['about:blank', configuredUrl]) {
      preference.url = destination;
      for (const surface of ['workspace', 'toolbar', 'page']) {
        if (surface === 'page') {
          const page = browser.createTab('about:blank', 'direct', { blankPage: true });
          await waitForMain(() => page.view.webContents.getURL() === 'about:blank', 'ordinary page ready');
        }
        const contents = surface === 'toolbar' ? toolbar : browser.activeTab().view.webContents;
        if (destination === 'about:blank') await stroke(`${surface}:release-only`, contents, { releaseOnly: true, expected: 0 });
        await stroke(`${surface}:${destination}`, contents);
        restoreTabs();
      }
    }
    preference.url = 'about:blank';
    const releasePage = browser.createTab('about:blank', 'direct', { blankPage: true });
    await waitForMain(() => releasePage.view.webContents.getURL() === 'about:blank', 'capacity release target ready');
    const errors = []; browser.onError = message => errors.push(message);
    browser.tabManager.canAdd = () => false;
    await stroke('toolbar:capacity', toolbar, { expected: 0, releaseContents: releasePage.view.webContents });
    assert.deepEqual(errors, [browser.t('tab.limit', { count: 24 })]);
  } finally {
    preference.url = originalPreference; browser.tabManager.canAdd = originalCapacity; browser.onError = originalError;
    restoreTabs();
  }
  const oldWindow = browser.window, savedToolbar = toolbar.listeners('before-input-event')[0];
  const savedWorkspace = workspace.view.webContents.listeners('before-input-event')[0];
  const veto = event => event.preventDefault(); oldWindow.on('close', veto);
  try {
    browser.close(); assert.equal(oldWindow.isDestroyed(), false);
    await stroke('workspace:vetoed-close', workspace.view.webContents, { expected: 0 });
    await stroke('toolbar:vetoed-close', toolbar, { expected: 0 });
  } finally { oldWindow.removeListener('close', veto); browser.close(); }
  await waitForMain(() => oldWindow.isDestroyed() && browser.window === null, 'native keyboard owner retirement');
  await browser.openWorkspace(11080);
  const count = browser.tabs.length, input = { type: 'keyDown', key: 't', [process.platform === 'darwin' ? 'meta' : 'control']: true };
  // These saved callbacks are synthetic stale-listener checks on retired native
  // objects, distinct from the delivered Electron input observations above.
  const event = { preventDefault: () => assert.fail('retired input consumed') };
  savedToolbar(event, input); savedWorkspace(event, input);
  assert.equal(browser.tabs.length, count);
  return observations;
}

module.exports = { assertNativeNewTabKeyboard };
