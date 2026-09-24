'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findSensitivePattern,
  parseIndexEntries,
  parseTreeEntries,
  scanGitEntries,
} = require('../../../scripts/check-sensitive-patterns');

test('secret pattern gate detects representative credentials without storing fixtures verbatim', () => {
  const github = `ghp_${'a'.repeat(36)}`;
  const aws = `AKIA${'A1'.repeat(8)}`;
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  assert.equal(findSensitivePattern(github), 'github-token');
  assert.equal(findSensitivePattern(aws), 'aws-access-key');
  assert.equal(findSensitivePattern(privateKey), 'private-key');
});

test('synthetic auth vocabulary and redacted placeholders are not treated as real secrets', () => {
  assert.equal(findSensitivePattern('synthetic-accepted <redacted> transaction_closed'), null);
  assert.equal(findSensitivePattern('username=<redacted> token=<redacted>'), null);
});

test('binary and Unicode-normalized secret shapes are still scanned', () => {
  const binary = Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from(`ghp_${'b'.repeat(36)}`, 'ascii'),
    Buffer.from([0, 255]),
  ]);
  assert.equal(findSensitivePattern(binary), 'github-token');
  const unicodePrivateKey = ['－－－－－ＢＥＧＩＮ', 'ＰＲＩＶＡＴＥ', 'ＫＥＹ－－－－－'].join(' ');
  assert.equal(
    findSensitivePattern(unicodePrivateKey),
    'private-key',
  );
});

test('index and tree parsers preserve staged new, renamed and Unicode paths', () => {
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);
  assert.deepEqual(parseIndexEntries(Buffer.from(
    `100644 ${first} 0\tnew-file.js\0` +
    `100644 ${second} 0\trenamed-凭据.js\0`,
  )), [
    { mode: '100644', object: first, stage: 0, file: 'new-file.js' },
    { mode: '100644', object: second, stage: 0, file: 'renamed-凭据.js' },
  ]);
  assert.deepEqual(parseTreeEntries(Buffer.from(
    `100644 blob ${first}\ttree-file.js\0`,
  )), [{ mode: '100644', type: 'blob', object: first, stage: 0, file: 'tree-file.js' }]);
});

test('Git snapshot scan fails closed on conflicts, symlinks, oversize and staged secrets', () => {
  const entries = [
    { mode: '100644', object: '1', stage: 2, file: 'conflicted.js' },
    { mode: '120000', object: '2', stage: 0, file: 'linked-secret' },
    { mode: '100644', object: '3', stage: 0, file: 'oversized.bin' },
    { mode: '100644', object: '4', stage: 0, file: 'renamed-secret.js' },
  ];
  const findings = scanGitEntries('/unused', entries, {
    readBlob: (_root, object) => object === '3'
      ? { oversized: true, data: null }
      : { oversized: false, data: Buffer.from(`AKIA${'A1'.repeat(8)}`) },
  });
  assert.deepEqual(findings, [
    { file: 'conflicted.js', pattern: 'index-conflict' },
    { file: 'linked-secret', pattern: 'unsupported-symlink' },
    { file: 'oversized.bin', pattern: 'oversized-unscanned-blob' },
    { file: 'renamed-secret.js', pattern: 'aws-access-key' },
  ]);
});
