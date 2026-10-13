'use strict';
const assert = require('node:assert/strict');
const { CampusBrowser } = require('../../lib/browser/session/campus-browser');
const { createCampusBrowserWindowOwner } = require('../../lib/browser/session/campus-browser-manager');

function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function assertNativeToolbarRetirement({ BrowserWindow, WebContentsView, session, host, waitForMain }) {
  const messages = []; let pending, updates = 0;
  const root = new CampusBrowser({
    BrowserWindow, WebContentsView, session, createWindowOwner: createCampusBrowserWindowOwner,
    dialog: {}, certificateTrust: {}, credentialVault: null, parentWindow: () => null,
    toolbarFile: host.toolbarFile, toolbarPreload: host.toolbarPreload, campusPreload: host.campusPreload,
    partition: 'persist:synthetic-toolbar-retirement', homeUrl: 'about:blank',
    routingPolicy: host.routingPolicy, ensureCampusReady: async () => true,
    onOpenResource: () => pending.promise, onError: message => messages.push(message),
  });
  const url = 'http://synthetic-toolbar.example.invalid:1/'; // Chromium blocks before network I/O.
  root.toolbarCommands.actions.updateToolbar = () => { updates++; };
  try {
    for (const outcome of ['success', 'failure']) {
      await root.open(url, 11080, 'direct');
      const old = root.window; pending = deferred();
      root.handleToolbarCommand({ command: 'open-resource', value: 'synthetic-resource' });
      root.close();
      await waitForMain(() => old.isDestroyed() && root.window === null, 'closed toolbar command origin');
      await root.open(url, 11080, 'direct');
      assert.notEqual(root.window, old);
      if (outcome === 'success') pending.resolve({ ok: true });
      else pending.reject(new Error('synthetic retired resource failure'));
      await new Promise(setImmediate);
      assert.equal(updates, 0); assert.deepEqual(messages, []);
    }
    // Current feedback is preserved, not globally silenced.
    pending = deferred(); root.handleToolbarCommand({ command: 'open-resource', value: 'synthetic-resource' });
    pending.reject(new Error('synthetic current resource failure')); await new Promise(setImmediate);
    assert.deepEqual(messages, ['synthetic current resource failure']); messages.length = 0;
    root.handleToolbarCommand({ command: 'find', value: 'synthetic prior window query' });
    const live = root.window, veto = event => event.preventDefault();
    live.on('close', veto);
    try {
      pending = deferred(); root.handleToolbarCommand({ command: 'open-resource', value: 'synthetic-resource' });
      root.close(); assert.equal(live.isDestroyed(), false);
      assert.equal(root.toolbarCommands.lastFindQuery, '');
      pending.reject(new Error('synthetic vetoed close failure')); await new Promise(setImmediate);
      assert.deepEqual(messages, []);
      pending = deferred();
      root.handleToolbarCommand({ command: 'open-resource', value: 'synthetic-resource' });
      root.windowOwner.retireAdmission();
      pending.reject(new Error('synthetic retired context failure')); await new Promise(setImmediate);
      assert.deepEqual(messages, []);
      assert.equal(root.handleToolbarCommand({ command: 'open-settings' }), false);
    } finally { live.removeListener('close', veto); }
  } finally {
    const window = root.window;
    root.close();
    if (window && !window.isDestroyed()) await waitForMain(() => window.isDestroyed(), 'native toolbar fixture cleanup');
  }
  process.stdout.write('native toolbar command retirement: PASS\n');
}

module.exports = { assertNativeToolbarRetirement };
