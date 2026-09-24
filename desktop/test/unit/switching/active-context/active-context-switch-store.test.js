'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureOwnerOnly } = require('../../../../lib/platform/storage/private-file');
const {
  protectWindowsFileOwnerOnly,
  verifyWindowsFileOwnerOnly,
} = require('../../../../lib/platform/storage/windows-private-file');
const {
  commitActiveContextSwitch,
  createPreparedActiveContextSwitch,
  markActiveContextSwitchReady,
} = require('../../../../lib/switching/active-context/active-context-switch-journal');
const {
  ActiveContextSwitchJournalStore,
} = require('../../../../lib/switching/active-context/active-context-switch-store');

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

function receipt(seed) {
  return { present: true, bytes: seed + 50, sha256: seed.toString(16).padStart(64, '0') };
}

function activation(seed) {
  return {
    globalSettings: { before: receipt(seed), after: receipt(seed + 1) },
    destinationWorkspace: { before: receipt(seed + 2), after: receipt(seed + 3) },
  };
}

function prepared(seed = 1) {
  return createPreparedActiveContextSwitch({
    from: context('school-a', '1', '2', '3', 4),
    to: context('school-b', '4', '5', '6', 2),
    engineGeneration: 9,
    activation: activation(seed),
    randomBytes: () => Buffer.alloc(16, seed),
    now: () => 1_800_000_000_000 + seed,
  });
}

function ready(value) {
  return markActiveContextSwitchReady(value, { now: () => 1_800_000_000_100 });
}

function committed(value) {
  return commitActiveContextSwitch(value, { now: () => 1_800_000_000_200 });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-context-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    file: path.join(root, 'global', 'active-context-switch.json'),
  };
}

test('owner-only store persists one prepared ready committed transition', (t) => {
  const { file } = fixture(t);
  const store = new ActiveContextSwitchJournalStore({ filePath: file });
  const first = prepared();
  const second = ready(first);
  const third = committed(second);

  assert.equal(store.read(), null);
  assert.deepEqual(store.prepare(first), { prepared: true, durabilityUnconfirmed: false });
  assert.deepEqual(store.markReady(second), { ready: true, durabilityUnconfirmed: false });
  assert.deepEqual(store.commit(third), { committed: true, durabilityUnconfirmed: false });
  assert.deepEqual(store.read(), third);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.clearCommitted(), true);
  assert.equal(store.read(), null);
  assert.equal(store.clearCommitted(), false);
});

test('store rejects skipped states, concurrent identity and premature clearing', (t) => {
  const { file } = fixture(t);
  const store = new ActiveContextSwitchJournalStore({ filePath: file });
  const first = prepared();
  store.prepare(first);
  assert.throws(() => store.commit(committed(ready(first))), /not ready/u);
  assert.throws(() => store.clearCommitted(), /uncommitted/u);
  store.markReady(ready(first));
  assert.throws(() => store.commit(committed(ready(prepared(7)))), /binding/u);
  assert.throws(() => store.prepare(prepared(8)), /already exists/u);
  assert.equal(store.read().switchId, first.switchId);
});

test('reads reject symbolic links, hard links and broad POSIX permissions', {
  skip: process.platform === 'win32',
}, (t) => {
  const { root, file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const unrelated = path.join(root, 'unrelated.json');
  fs.writeFileSync(unrelated, JSON.stringify(prepared()), { mode: 0o600 });

  fs.symlinkSync(unrelated, file);
  assert.throws(() => new ActiveContextSwitchJournalStore({ filePath: file }).read(),
    /private file/u);
  fs.unlinkSync(file);
  fs.linkSync(unrelated, file);
  assert.throws(() => new ActiveContextSwitchJournalStore({ filePath: file }).read(),
    /private file/u);
  fs.unlinkSync(file);
  fs.copyFileSync(unrelated, file);
  fs.chmodSync(file, 0o644);
  assert.throws(() => new ActiveContextSwitchJournalStore({ filePath: file }).read(),
    /private file/u);
});

test('failure before rename preserves the previous state', (t) => {
  const { file } = fixture(t);
  const first = prepared();
  const base = new ActiveContextSwitchJournalStore({ filePath: file });
  base.prepare(first);
  const injected = Object.create(fs);
  injected.renameSync = () => { throw new Error('simulated rename failure'); };
  const store = new ActiveContextSwitchJournalStore({ filePath: file, fileSystem: injected });
  assert.throws(() => store.markReady(ready(first)), /ready failed/u);
  assert.deepEqual(base.read(), first);
});

test('a readable transition resolves post-rename directory fsync uncertainty', {
  skip: process.platform === 'win32',
}, (t) => {
  const { file } = fixture(t);
  const first = prepared();
  const base = new ActiveContextSwitchJournalStore({ filePath: file });
  base.prepare(first);
  const injected = Object.create(fs);
  injected.fsyncSync = (descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) {
      throw new Error('simulated directory fsync failure');
    }
    return fs.fsyncSync(descriptor);
  };
  const store = new ActiveContextSwitchJournalStore({ filePath: file, fileSystem: injected });
  const next = ready(first);
  assert.deepEqual(store.markReady(next), { ready: true, durabilityUnconfirmed: true });
  assert.deepEqual(base.read(), next);
});

test('journal disappearance and malformed content are never treated as absence', (t) => {
  const { file } = fixture(t);
  const base = new ActiveContextSwitchJournalStore({ filePath: file });
  base.prepare(prepared());
  const injected = Object.create(fs);
  let observations = 0;
  injected.lstatSync = (value, ...args) => {
    if (value === file && ++observations === 2) {
      fs.unlinkSync(file);
      const error = new Error('simulated disappearance');
      error.code = 'ENOENT';
      throw error;
    }
    return fs.lstatSync(value, ...args);
  };
  assert.throws(() => new ActiveContextSwitchJournalStore({
    filePath: file,
    fileSystem: injected,
  }).read(), /disappeared after observation/u);

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const [content, causeType] of [['{!', SyntaxError], ['{}', TypeError]]) {
    fs.writeFileSync(file, content, { mode: 0o600 });
    // This test owns this synthetic file; do not use the foreign-owner-preserving read helper
    // to initialize an elevated Windows fixture whose default owner can be Administrators.
    assert.equal(process.platform === 'win32' ? protectWindowsFileOwnerOnly(file) : ensureOwnerOnly(file),
      true, 'malformed fixture must pass the private-file gate');
    assert.throws(() => base.read(), (error) => {
      assert.match(error.message, /journal is invalid/u);
      assert.ok(error.cause instanceof causeType);
      return true;
    });
  }
});

test('native Windows rejects an inherited journal ACL before parsing malformed content', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{!', { mode: 0o600 });
  const store = new ActiveContextSwitchJournalStore({ filePath: file });
  assert.equal(verifyWindowsFileOwnerOnly(file), false);
  assert.throws(() => store.read(), /journal ACL is invalid/u);
  assert.equal(protectWindowsFileOwnerOnly(file), true);
  assert.throws(() => store.read(), (error) => {
    assert.match(error.message, /journal is invalid/u);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

test('simulated Windows store protects and verifies every journal generation', (t) => {
  const { file } = fixture(t);
  const protectedPaths = [];
  const verifiedPaths = [];
  const windowsAcl = {
    protect(value) { protectedPaths.push(value); return true; },
    verify(value) { verifiedPaths.push(value); return fs.existsSync(value); },
  };
  const store = new ActiveContextSwitchJournalStore({
    filePath: file,
    platform: 'win32',
    windowsAcl,
  });
  const first = prepared();
  store.prepare(first);
  store.markReady(ready(first));
  store.commit(committed(ready(first)));
  assert.equal(store.read().state, 'committed');
  assert.equal(protectedPaths.includes(file), true);
  assert.equal(protectedPaths.filter((value) => value.endsWith('.tmp')).length, 2);
  assert.equal(verifiedPaths.filter((value) => value === file).length >= 4, true);
});

test('store path is absolute and Windows ACL failure removes a new journal', (t) => {
  assert.throws(() => new ActiveContextSwitchJournalStore({ filePath: 'relative.json' }),
    /absolute/u);
  const { file } = fixture(t);
  const store = new ActiveContextSwitchJournalStore({
    filePath: file,
    platform: 'win32',
    windowsAcl: { protect: () => false, verify: () => false },
  });
  assert.throws(() => store.prepare(prepared()), /prepare failed/u);
  assert.equal(fs.existsSync(file), false);
});
