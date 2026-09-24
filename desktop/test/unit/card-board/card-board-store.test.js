'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CardBoardStore } = require('../../../lib/card-board/runtime/card-board-store');
const { emptyCardBoardLayoutDocument } = require('../../../lib/card-board/schema/card-board-contract');
const { verifyWindowsFileOwnerOnly } = require('../../../lib/platform/storage/windows-private-file');

test('card board store is missing-safe and atomically persists an owner-only document', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-card-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'workspace', 'card-board-layout.json');
  const store = new CardBoardStore({ filePath, platform: process.platform });
  assert.equal(store.read(), null);
  const written = store.replace(emptyCardBoardLayoutDocument());
  assert.deepEqual(store.read(), written);
  if (process.platform === 'win32') {
    assert.equal(verifyWindowsFileOwnerOnly(filePath), true);
  } else {
    assert.equal(fs.statSync(filePath).mode & 0o077, 0);
  }
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith('.tmp')), false);
});

test('card board store refuses malformed, symlinked and hard-linked authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-card-board-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.json');
  const link = path.join(root, 'card-board-layout.json');
  fs.writeFileSync(target, JSON.stringify(emptyCardBoardLayoutDocument()), { mode: 0o600 });
  fs.symlinkSync(target, link);
  assert.throws(() => new CardBoardStore({ filePath: link, platform: 'darwin' }).read(), /private|invalid/u);
  fs.unlinkSync(link);
  if (process.platform !== 'win32') {
    fs.linkSync(target, link);
    assert.throws(() => new CardBoardStore({ filePath: link, platform: 'darwin' }).read(), /private|invalid/u);
    fs.unlinkSync(link);
  }
  fs.writeFileSync(link, '{broken', { mode: 0o600 });
  assert.throws(() => new CardBoardStore({ filePath: link, platform: 'darwin' }).read(), /invalid/u);
  assert.equal(fs.readFileSync(link, 'utf8'), '{broken');
});

test('card board store applies and verifies Windows owner-only ACL', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-card-board-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'card-board-layout.json');
  const calls = [];
  const windowsAcl = {
    protect(file) { calls.push(['protect', path.basename(file)]); return true; },
    verify(file) { calls.push(['verify', path.basename(file)]); return true; },
  };
  const store = new CardBoardStore({ filePath, platform: 'win32', windowsAcl });
  store.replace(emptyCardBoardLayoutDocument());
  assert.deepEqual(store.read(), emptyCardBoardLayoutDocument());
  assert.equal(calls.some(([name, file]) => name === 'protect' && file.endsWith('.tmp')), true);
  assert.equal(calls.filter(([name]) => name === 'verify').length >= 2, true);
});
