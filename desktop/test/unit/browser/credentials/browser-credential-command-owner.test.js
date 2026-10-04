'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserCredentialCommandOwner } = require('../../../../lib/browser/credentials/credential-controller');

const origin = 'https://login.example.invalid';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(setImmediate);
const credential = () => ({ origin, username: 'synthetic-user', password: 'synthetic-secret', updatedAt: 1 });

function fixture() {
  const sends = [], prompts = [], errors = [], deletes = [], tabs = new Set();
  let window = { isDestroyed: () => false }, current = true;
  const tab = { origin, revision: 1, sharedCredentialAttemptedOrigin: '', view: { webContents: {
    send: (channel, value) => sends.push([channel, structuredClone(value)]),
  } } };
  tabs.add(tab);
  let vault = { get: async () => credential(), remove: async value => { deletes.push(value); } };
  let dialog = { showMessageBox: async (parent, value) => { prompts.push([parent, value]); return { response: 0 }; } };
  let shared = () => null;
  const owner = new BrowserCredentialCommandOwner({
    getVault: () => vault, getDialog: () => dialog, getWindow: () => window,
    originForTab: value => value.origin,
    captureAdmission: value => current && tabs.has(value) ? { tab: value, revision: value.revision, window } : null,
    admissionCurrent: value => current && tabs.has(value.tab) && value.tab.revision === value.revision && window === value.window,
    getSharedPortalCredential: value => shared(value),
    translate: key => key, reportError: value => errors.push(value),
  });
  return { owner, tab, sends, prompts, errors, deletes, tabs, vault, dialog,
    setVault: value => { vault = value; }, setDialog: value => { dialog = value; },
    setWindow: value => { window = value; }, retire: () => { current = false; },
    setShared: value => { shared = value; } };
}

function sharedOwner() {
  const counts = { reads: 0, destroys: 0 };
  const value = { withStrings(callback) { counts.reads++; return callback('synthetic-user', 'synthetic-secret'); },
    destroy() { counts.destroys++; } };
  return { value, counts };
}

test('manage joins one lookup/prompt and copies before erasing its vault projection', async () => {
  const f = fixture(), lookup = deferred(), raw = credential(); let reads = 0;
  f.vault.get = () => { reads++; return lookup.promise; };
  const first = f.owner.manage(f.tab), duplicate = f.owner.manage(f.tab);
  assert.equal(first, duplicate); await tick(); assert.equal(reads, 1);
  lookup.resolve(raw); await first;
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0][1].type, 'question');
  assert.deepEqual(f.sends, [['campus-credential-fill', credential()]]);
  assert.equal(raw.password, ''); assert.equal(raw.username, '');
  assert.equal(f.owner.manages.size, 0);
});

test('delete stays bound to the approved origin and clears plaintext before removal', async () => {
  const f = fixture(), raw = credential();
  f.vault.get = async () => raw;
  f.dialog.showMessageBox = async () => ({ response: 1 });
  f.vault.remove = async value => {
    assert.equal(value, origin); assert.equal(raw.password, ''); f.deletes.push(value);
  };
  await f.owner.manage(f.tab);
  assert.deepEqual(f.deletes, [origin]); assert.deepEqual(f.sends, []);
});

test('missing credentials and non-HTTPS scope retain existing informational behavior', async () => {
  const f = fixture(); f.vault.get = async () => null;
  await f.owner.manage(f.tab);
  assert.equal(f.prompts[0][1].type, 'info'); assert.deepEqual(f.prompts[0][1].buttons, ['cred.ok']);
  assert.deepEqual(f.sends, []);
  f.tab.origin = 'http://login.example.invalid';
  await f.owner.manage(f.tab);
  assert.deepEqual(f.errors, ['cred.httpsOnly']); assert.equal(f.prompts.length, 1);
});

test('lookup completion revalidates page/window/context/vault/dialog and erases stale results', async () => {
  for (const retire of [f => { f.tab.revision++; }, f => { f.tab.origin = 'https://other.example.invalid'; },
    f => f.setWindow({ isDestroyed: () => false }), f => f.retire(), f => f.tabs.delete(f.tab),
    f => f.setVault({}), f => f.setDialog({}), f => f.owner.reset()]) {
    const f = fixture(), lookup = deferred(), raw = credential();
    f.vault.get = () => lookup.promise;
    const pending = f.owner.manage(f.tab); await tick(); retire(f); lookup.resolve(raw); await pending;
    assert.deepEqual(f.prompts, []); assert.deepEqual(f.sends, []); assert.deepEqual(f.deletes, []);
    assert.equal(raw.password, ''); assert.equal(f.owner.manages.size, 0);
  }
});

test('dialog results cannot fill or delete after navigation/closure and reset clears held plaintext', async () => {
  for (const response of [0, 1]) for (const retire of [f => { f.tab.revision++; },
    f => f.retire(), f => f.owner.clearTab(f.tab), f => f.owner.reset()]) {
    const f = fixture(), answer = deferred(), raw = credential();
    f.vault.get = async () => raw; f.dialog.showMessageBox = () => answer.promise;
    const pending = f.owner.manage(f.tab); await tick(); retire(f);
    if (f.owner.manages.size === 0) assert.equal(raw.password, '', 'explicit retirement immediately clears acquired projection');
    answer.resolve({ response }); await pending;
    assert.deepEqual(f.sends, []); assert.deepEqual(f.deletes, []); assert.equal(raw.password, '');
  }
});

test('shared login joins one lookup, preserves payload and destroys once', async () => {
  const f = fixture(), lookup = deferred(), shared = sharedOwner(); let calls = 0;
  f.setShared(() => { calls++; return lookup.promise; });
  const first = f.owner.fillShared(f.tab), duplicate = f.owner.fillShared(f.tab);
  assert.equal(first, duplicate); await tick(); assert.equal(calls, 1);
  lookup.resolve(shared.value); assert.equal(await first, true);
  assert.deepEqual(f.sends, [['campus-credential-fill', { origin,
    username: 'synthetic-user', password: 'synthetic-secret', source: 'connection-credential', autoSubmit: true }]]);
  assert.deepEqual(shared.counts, { reads: 1, destroys: 1 });
  assert.equal(f.owner.fills.size, 0); assert.equal(await f.owner.fillShared(f.tab), false); assert.equal(calls, 1);
});

test('stale shared lookup never materializes strings but always destroys acquired owner', async () => {
  for (const retire of [f => { f.tab.revision++; }, f => { f.tab.origin = 'https://other.example.invalid'; },
    f => f.setWindow({ isDestroyed: () => false }), f => f.retire(), f => f.tabs.delete(f.tab),
    f => f.setVault({}), f => f.setDialog({}), f => f.owner.reset()]) {
    const f = fixture(), lookup = deferred(), shared = sharedOwner(); f.setShared(() => lookup.promise);
    const pending = f.owner.fillShared(f.tab); await tick(); retire(f); lookup.resolve(shared.value);
    assert.equal(await pending, false); assert.deepEqual(f.sends, []);
    assert.deepEqual(shared.counts, { reads: 0, destroys: 1 }); assert.equal(f.owner.fills.size, 0);
  }
});

test('older shared completion cannot clear a replacement document flight', async () => {
  const f = fixture(), firstLookup = deferred(), secondLookup = deferred(); let calls = 0;
  f.setShared(() => ++calls === 1 ? firstLookup.promise : secondLookup.promise);
  const first = f.owner.fillShared(f.tab); await tick(); f.tab.revision++;
  const second = f.owner.fillShared(f.tab); await tick(); const replacement = f.owner.fills.get(f.tab);
  const old = sharedOwner(); firstLookup.resolve(old.value); assert.equal(await first, false);
  assert.equal(f.owner.fills.get(f.tab), replacement); assert.deepEqual(old.counts, { reads: 0, destroys: 1 });
  const fresh = sharedOwner(); secondLookup.resolve(fresh.value); assert.equal(await second, true);
  assert.equal(f.sends.length, 1); assert.equal(f.owner.fills.size, 0);
});

test('retirement inside withStrings cannot send or double-destroy its owner', async () => {
  const f = fixture(), shared = sharedOwner();
  shared.value.withStrings = callback => { f.owner.reset(); return callback('synthetic-user', 'synthetic-secret'); };
  f.setShared(() => shared.value); assert.equal(await f.owner.fillShared(f.tab), false);
  assert.deepEqual(f.sends, []); assert.equal(shared.counts.destroys, 1);
  f.owner.reset(); assert.equal(shared.counts.destroys, 1);
});

test('malformed shared owners fail closed and cleanup ambiguity remains owned for retry', async () => {
  const f = fixture(); let destroys = 0;
  f.setShared(() => ({ destroy: () => { destroys++; } }));
  assert.equal(await f.owner.fillShared(f.tab), false); assert.equal(destroys, 1);
  const shared = sharedOwner(); let fail = true;
  shared.value.destroy = () => { if (fail) throw new Error('synthetic cleanup failure'); shared.counts.destroys++; };
  f.setShared(() => shared.value);
  await assert.rejects(f.owner.fillShared(f.tab), /synthetic cleanup failure/);
  assert.equal(f.owner.fills.size, 1); assert.equal(f.owner.fills.get(f.tab).active, false);
  fail = false; f.owner.reset(); assert.equal(f.owner.fills.size, 0); assert.equal(shared.counts.destroys, 1);
});

test('errors are actionable only for current scope; unavailable/retired dependencies stay inert', async () => {
  const f = fixture(); f.vault.get = async () => { throw new Error('synthetic read failure'); };
  await f.owner.manage(f.tab); assert.deepEqual(f.errors, ['cred.readFailed']);
  f.retire(); await f.owner.manage(f.tab); assert.equal(await f.owner.fillShared(f.tab), false);
  assert.deepEqual(f.errors, ['cred.readFailed']);
  assert.throws(() => new BrowserCredentialCommandOwner(), /dependencies/);
});
