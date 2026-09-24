'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeEngineOwnerRecord, loadEngineOwnerRecord } = require('../../../../lib/connection/engine/engine-supervisor');
const { verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-owner-private-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'owner.json'), owner: { pid: 12345, executablePath: path.join(root, 'synthetic-engine.exe') } };
}
test('Windows owner record is protected before publication and verified after rename', t => {
  const f = fixture(t), calls = [], io = Object.create(fs);
  io.renameSync = (from, to) => { calls.push('rename'); assert.equal(to, f.file); fs.renameSync(from, to); };
  writeEngineOwnerRecord(f.file, f.owner, { platform: 'win32', fileSystem: io, windowsAcl: {
    protect(file) { calls.push('protect'); assert.notEqual(file, f.file); assert.equal(fs.existsSync(f.file), false); return true; },
    verify(file) { calls.push('verify'); assert.equal(file, f.file); return true; },
  } });
  assert.deepEqual(calls, ['protect', 'rename', 'verify']);
  assert.deepEqual(loadEngineOwnerRecord(f.file), { version: 1, ...f.owner });
});
test('failed temporary protection preserves the previous owner and removes only its temporary file', t => {
  const f = fixture(t); writeEngineOwnerRecord(f.file, f.owner);
  const original = fs.readFileSync(f.file);
  assert.throws(() => writeEngineOwnerRecord(f.file, { ...f.owner, pid: 54321 }, {
    platform: 'win32', windowsAcl: { protect: () => false, verify: () => assert.fail('unpublished record cannot be verified') },
  }), /not a private file/);
  assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(fs.readdirSync(f.root), ['owner.json']);
});
test('failed committed verification remains fail-closed instead of reporting a durable owner', t => {
  const f = fixture(t);
  assert.throws(() => writeEngineOwnerRecord(f.file, f.owner, {
    platform: 'win32', windowsAcl: { protect: () => true, verify: () => false },
  }), /not a private file/);
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(fs.readdirSync(f.root), []);
});
test('native Windows creates and replaces a real private owner record under the current token', {
  skip: process.platform !== 'win32',
}, t => {
  const f = fixture(t);
  for (const pid of [12345, 23456]) {
    writeEngineOwnerRecord(f.file, { ...f.owner, pid });
    assert.equal(verifyWindowsFileOwnerOnly(f.file, { nativeHelper: false }), true);
    assert.deepEqual(loadEngineOwnerRecord(f.file), { version: 1, ...f.owner, pid });
    assert.deepEqual(fs.readdirSync(f.root), ['owner.json']);
  }
});
