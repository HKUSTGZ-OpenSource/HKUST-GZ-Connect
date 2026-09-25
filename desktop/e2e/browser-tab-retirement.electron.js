'use strict';

// Real native-view retirement with a delayed, synthetic Workspace completion.
// No Gateway, campus data, real account or installed App is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { BrowserTabLifecycle } = require('../lib/browser/tabs/tab-manager');
const { scheduleTemporaryProfileCleanup } = require('../scripts/temp-profile-cleanup');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-tab-retirement-'));
scheduleTemporaryProfileCleanup(profile, 'hkustgz-tab-retirement');
app.setPath('userData', profile);

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  try {
    const calls = [];
    const effects = Object.fromEntries([
      'linkPopup', 'closeTabState', 'releasePopup', 'attachPageEvents', 'navigate',
      'scheduleToolbarUpdate', 'updateToolbar', 'beforeDeactivate', 'layout',
      'cancelScheduledUpdates', 'cancelCertificatePrompts', 'clearSlowTimer',
      'clearCredentialCandidate', 'openNewTab', 'reportCreateFailure',
    ].map(name => [name, () => { calls.push(name); }]));
    let finish;
    let actualLoad;
    let delayed = new Promise(resolve => { finish = resolve; });
    const workspace = {
      createView: (View, pageSession) => new View({ webPreferences: { session: pageSession,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } }),
      load: view => {
        actualLoad = view.webContents.loadURL('about:blank');
        return actualLoad.then(() => delayed);
      },
      sendState: () => calls.push('workspaceState'),
      focus: () => calls.push('workspaceFocus'),
    };
    const owner = new BrowserTabLifecycle({ WebContentsView, campusPreload: '',
      getWindow: () => window, getToolbarHeight: () => 108, getWorkspace: () => workspace, effects });
    const pageSession = session.fromPartition('synthetic-tab-retirement');
    const tab = owner.createWorkspace(pageSession);
    assert.ok(tab);
    assert.equal(tab.view.webContents.session, pageSession);
    await actualLoad;
    tab.pendingWorkspaceFocus = { target: 'search', query: 'synthetic' };
    assert.equal(owner.close(tab.id), true);
    calls.length = 0;
    finish();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual(calls, [], 'retired native view must not publish, focus or update the toolbar');
    assert.equal(owner.size, 0);
    assert.equal(owner.attachedView, null);

    delayed = new Promise(resolve => { finish = resolve; });
    const background = owner.createWorkspace(pageSession);
    await actualLoad;
    background.pendingWorkspaceFocus = { target: 'search', query: 'synthetic' };
    const foregroundView = workspace.createView(WebContentsView, pageSession);
    await foregroundView.webContents.loadURL('about:blank');
    const foreground = owner.add({ view: foregroundView, kind: 'blank' });
    assert.equal(owner.activate(foreground.id), true);
    calls.length = 0;
    finish();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(owner.active(), foreground);
    assert.deepEqual(window.contentView.children, [foregroundView]);
    assert.equal(background.loading, false);
    assert.equal(background.pendingWorkspaceFocus, null);
    assert.equal(calls.includes('workspaceState'), true);
    assert.equal(calls.includes('workspaceFocus'), false, 'background completion cannot deliver stale focus');
    owner.close(background.id);
    owner.close(foreground.id);
    assert.equal(owner.size, 0);
    console.log('native Browser tab retirement: PASS');
  } finally {
    window.destroy();
  }
}

main().then(() => app.quit(), error => { console.error(error); app.exit(1); });
