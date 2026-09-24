'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureOwnerOnly } = require('../../../../lib/platform/storage/private-file');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');
const { ActiveContextActivationStore } = require('../../../../lib/switching/active-context/active-context-activation-store');
const {
  createPreparedActiveContextSwitch,
  markActiveContextSwitchReady,
} = require('../../../../lib/switching/active-context/active-context-switch-journal');
const {
  createProfileAccountWorkspaceLayout,
} = require('../../../../lib/persistence/paths/profile-workspace-layout');

function key(name, seed) { return `${name}-${String(seed).repeat(32)}`; }

function context(profileId, profileSeed, accountSeed, workspaceSeed, epoch) {
  return {
    profileId,
    profileKey: key('profile', profileSeed),
    profileRevision: 1,
    profileCredentialBindingRevision: 1,
    accountKey: key('account', accountSeed),
    accountRevision: 1,
    accountCredentialRevision: 1,
    workspaceKey: key('workspace', workspaceSeed),
    activeContextEpoch: epoch,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  // These are newly created synthetic files. Elevated Windows can assign Administrators
  // as their default owner; creation protection is distinct from tightening an existing file.
  assert.equal(process.platform === 'win32' ? protectWindowsFileOwnerOnly(file) : ensureOwnerOnly(file),
    true, 'fixture must satisfy the real private-file boundary');
}

function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'active-context-activation-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const from = context('school-a', '1', '2', '3', 5);
  const to = context('school-b', '4', '5', '6', 2);
  const toLayout = createProfileAccountWorkspaceLayout({
    userData,
    profileKey: to.profileKey,
    accountKey: to.accountKey,
    workspaceKey: to.workspaceKey,
  });
  const globalSettings = path.join(userData, 'global', 'settings.json');
  writeJson(globalSettings, {
    schemaVersion: 1,
    activeProfileKey: from.profileKey,
    activeAccountKey: from.accountKey,
    port: 6180,
    strictProxyAuth: true,
    proxySecurityVersion: 3,
    proxyAuthMigrationPending: false,
    closeAction: 'ask',
    language: 'auto',
    startAtLogin: false,
  });
  writeJson(toLayout.workspace.state, {
    schemaVersion: 1,
    profileId: to.profileId,
    profileRevision: to.profileRevision,
    accountKey: to.accountKey,
    accountRevision: to.accountRevision,
    workspaceKey: to.workspaceKey,
    activeContextEpoch: to.activeContextEpoch,
  });
  return {
    userData,
    from,
    to,
    toLayout,
    globalSettings,
    store: new ActiveContextActivationStore({ userData }),
  };
}

function ready(value) {
  const activation = value.store.plan({
    from: value.from,
    to: value.to,
    nextActiveContextEpoch: 6,
  });
  const prepared = createPreparedActiveContextSwitch({
    from: value.from,
    to: value.to,
    nextActiveContextEpoch: 6,
    engineGeneration: 7,
    activation,
    randomBytes: () => Buffer.alloc(16, 0xaa),
    now: () => 1_800_000_000_000,
  });
  return markActiveContextSwitchReady(prepared, { now: () => 1_800_000_000_100 });
}

test('plan binds and apply commits destination epoch before active GlobalSettings pair', (t) => {
  const value = fixture(t);
  const journal = ready(value);
  const before = value.store.readState(journal);
  assert.deepEqual(before, {
    globalSettings: journal.activation.globalSettings.before,
    destinationWorkspace: journal.activation.destinationWorkspace.before,
  });
  assert.equal(value.store.apply(journal), true);
  assert.deepEqual(value.store.readState(journal), {
    globalSettings: journal.activation.globalSettings.after,
    destinationWorkspace: journal.activation.destinationWorkspace.after,
  });
  const global = JSON.parse(fs.readFileSync(value.globalSettings, 'utf8'));
  const workspace = JSON.parse(fs.readFileSync(value.toLayout.workspace.state, 'utf8'));
  assert.equal(global.activeProfileKey, value.to.profileKey);
  assert.equal(global.activeAccountKey, value.to.accountKey);
  assert.equal(workspace.activeContextEpoch, 6);
});

test('crash between Workspace and GlobalSettings writes resumes mixed activation', (t) => {
  const value = fixture(t);
  const journal = ready(value);
  const injected = Object.create(fs);
  injected.renameSync = (source, destination) => {
    if (destination === value.globalSettings) throw new Error('synthetic activation crash');
    return fs.renameSync(source, destination);
  };
  const crashing = new ActiveContextActivationStore({
    userData: value.userData,
    fileSystem: injected,
  });
  assert.throws(() => crashing.apply(journal), /write failed: globalSettings/u);
  assert.deepEqual(value.store.readState(journal), {
    globalSettings: journal.activation.globalSettings.before,
    destinationWorkspace: journal.activation.destinationWorkspace.after,
  });
  assert.equal(value.store.apply(journal), true);
  assert.deepEqual(value.store.readState(journal), {
    globalSettings: journal.activation.globalSettings.after,
    destinationWorkspace: journal.activation.destinationWorkspace.after,
  });
});

test('out-of-band target mutation blocks before activation can overwrite it', (t) => {
  const value = fixture(t);
  const journal = ready(value);
  const workspace = JSON.parse(fs.readFileSync(value.toLayout.workspace.state, 'utf8'));
  writeJson(value.toLayout.workspace.state, { ...workspace, accountRevision: 2 });
  assert.throws(() => value.store.apply(journal), /target changed: destinationWorkspace/u);
  const global = JSON.parse(fs.readFileSync(value.globalSettings, 'utf8'));
  assert.equal(global.activeProfileKey, value.from.profileKey);
});

test('planning rejects source authority or destination Workspace drift', (t) => {
  const value = fixture(t);
  assert.throws(() => value.store.plan({
    from: { ...value.from, accountKey: key('account', '9') },
    to: value.to,
    nextActiveContextEpoch: 6,
  }), /source authority/u);
  const workspace = JSON.parse(fs.readFileSync(value.toLayout.workspace.state, 'utf8'));
  writeJson(value.toLayout.workspace.state, { ...workspace, profileId: 'other-school' });
  assert.throws(() => value.store.plan({
    from: value.from,
    to: value.to,
    nextActiveContextEpoch: 6,
  }), /destination Workspace state/u);
});

test('simulated Windows verifies source ACLs and protects both committed targets', (t) => {
  const value = fixture(t);
  const protectedPaths = [];
  const verifiedPaths = [];
  const windowsAcl = {
    protect(file) { protectedPaths.push(file); return true; },
    verify(file) { verifiedPaths.push(file); return fs.existsSync(file); },
  };
  const store = new ActiveContextActivationStore({
    userData: value.userData,
    platform: 'win32',
    windowsAcl,
  });
  value.store = store;
  const journal = ready(value);
  assert.equal(store.apply(journal), true);
  assert.equal(verifiedPaths.includes(value.globalSettings), true);
  assert.equal(verifiedPaths.includes(value.toLayout.workspace.state), true);
  assert.equal(protectedPaths.filter((file) => file.endsWith('.tmp')).length, 2);
});

test('native Windows rejects a recreated source with inherited ACLs before activation', {
  skip: process.platform !== 'win32',
}, (t) => {
  const value = fixture(t);
  assert.equal(verifyWindowsFileOwnerOnly(value.globalSettings), true);
  assert.equal(verifyWindowsFileOwnerOnly(value.toLayout.workspace.state), true);
  const bytes = fs.readFileSync(value.globalSettings);
  fs.unlinkSync(value.globalSettings);
  fs.writeFileSync(value.globalSettings, bytes, { mode: 0o600 });
  assert.equal(verifyWindowsFileOwnerOnly(value.globalSettings), false,
    'mode 0600 must not be confused with a protected Windows DACL');
  assert.throws(() => ready(value), /GlobalSettings ACL is invalid/u);
});
