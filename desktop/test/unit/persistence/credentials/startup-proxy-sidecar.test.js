'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DesktopPersistenceRuntime } = require('../../../../lib/persistence/runtime/desktop-persistence-runtime');
const { ProxyAccessCoordinator } = require('../../../../lib/persistence/credentials/proxy-credential');

test('startup projection removal performs one unlink at the injected exact path', () => {
  const calls = [], file = path.resolve('synthetic-startup-sidecar');
  assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file, {
    unlinkSync: value => calls.push(value),
  }), true);
  assert.deepEqual(calls, [file]);
});

test('startup removal keeps absence successful and other removal failures unconfirmed', () => {
  for (const error of [{ code: 'ENOENT' }, { code: 'EACCES' }, { code: 'EIO' }, null]) {
    let calls = 0;
    assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(path.resolve('synthetic-sidecar'), {
      unlinkSync: () => { calls++; throw error; },
    }), error?.code === 'ENOENT');
    assert.equal(calls, 1);
  }
});

test('startup projection effect rejects malformed declarations before any I/O', () => {
  assert.equal(typeof DesktopPersistenceRuntime.discardStartupProxySidecar, 'function');
  let calls = 0;
  const io = { unlinkSync: () => { calls++; } };
  for (const file of [null, '', 'relative-sidecar']) {
    assert.throws(() => DesktopPersistenceRuntime.discardStartupProxySidecar(file, io), TypeError);
  }
  assert.throws(() => DesktopPersistenceRuntime.discardStartupProxySidecar(path.resolve('fixture'), {}), TypeError);
  assert.equal(calls, 0);
});

test('real startup unlink removes only its disposable projection and leaves the sibling', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-startup-sidecar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'helper.json'), sibling = path.join(root, 'sibling.json');
  fs.writeFileSync(file, 'synthetic-sidecar', { mode: 0o600 });
  fs.writeFileSync(sibling, 'synthetic-sibling', { mode: 0o600 });
  assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'synthetic-sibling');
  assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(file), true);
});

test('startup unlink does not follow a symlink into its target', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-startup-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'helper.json'), target = path.join(root, 'target.json');
  fs.writeFileSync(target, 'synthetic-target', { mode: 0o600 });
  fs.symlinkSync(target, link);
  assert.equal(DesktopPersistenceRuntime.discardStartupProxySidecar(link), true);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic-target');
});

test('existing owner removal remains bounded if the injected unlink effect later becomes unavailable', () => {
  const io = { unlinkSync() {} };
  const owner = new ProxyAccessCoordinator({ store: { loadOrCreate() {} },
    sidecarFile: path.resolve('synthetic-sidecar'), fileSystem: io,
    writeSidecar() {}, currentProfileId: () => 'fixture-profile',
  });
  io.unlinkSync = null;
  assert.equal(owner.removeSidecar(), false);
});
