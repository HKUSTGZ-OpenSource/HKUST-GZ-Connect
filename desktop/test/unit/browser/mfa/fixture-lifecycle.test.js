'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { accepted, retire, runChild, finishFixture } = require('../../../../e2e/support/owned-electron-fixture');
const stage = path.resolve(__dirname, '../../../../e2e/support/owned-child-fixture.cjs');
const marker = 'synthetic assertions: PASS';

test('success text cannot override a failed lifecycle or unhandled rejection', () => {
  const good = { closed: true, code: 0, output: marker };
  assert(accepted(good, marker));
  for (const bad of [{ closed: false }, { code: 1 }, { signal: 'SIGTERM' },
    { timedOut: true }, { launchError: true }, { outputLimit: true }, { interrupted: true },
    { output: `${marker}\nUnhandledPromiseRejectionWarning: cleanup failed` }]) {
    assert.equal(accepted({ ...good, ...bad }, marker), false);
  }
  assert.throws(() => finishFixture(good, '/unused', {}, marker,
    () => { throw new Error('synthetic cleanup failure'); }), /cleanup failure/);
  let removed = false;
  assert.throws(() => finishFixture({ ...good, closed: false }, '/unused', {}, marker,
    () => { removed = true; }), /close unconfirmed/);
  assert.equal(removed, false);
});

test('parent observes real child close before deleting its owned fixture', async () => {
  for (const mode of ['success', 'failure', 'timeout', 'flood']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned fixture test '));
    const identity = fs.lstatSync(root, { bigint: true });
    let closed = false;
    try {
      const result = await runChild(process.execPath, root, { stage, args: [mode],
        timeoutMs: mode === 'timeout' ? 300 : 3000 });
      closed = result.closed;
      assert.equal(result.closed, true);
      assert.equal(accepted(result, marker), mode === 'success');
      if (mode === 'timeout') assert.equal(result.timedOut, true);
      if (mode === 'flood') assert.equal(result.outputLimit, true);
      assert(Buffer.byteLength(result.output) <= 1024 * 1024);
      if (mode === 'success') finishFixture(result, root, identity, marker);
      else assert.throws(() => finishFixture(result, root, identity, marker), /did not complete/);
      assert.equal(fs.existsSync(root), false);
    } finally {
      if (closed && fs.existsSync(root)) retire(root, identity);
    }
  }
});

test('retirement refuses a replaced root and propagates removal errors', () => {
  const identity = { dev: 1n, ino: 2n };
  const stat = { ...identity, isDirectory: () => true, isSymbolicLink: () => false };
  let removed = false;
  assert.throws(() => retire('/unused', identity, {
    lstatSync: () => ({ ...stat, ino: 3n }), rmSync: () => { removed = true; },
  }), /identity changed/);
  assert.equal(removed, false);
  assert.throws(() => retire('/unused', identity, {
    lstatSync: () => stat, rmSync: () => { throw new Error('EPERM synthetic'); },
  }), /EPERM synthetic/);
});
