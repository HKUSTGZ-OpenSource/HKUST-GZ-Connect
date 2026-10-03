'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('all platform package jobs use the installed public builder CLI, never a vendor internal path', () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const source = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.equal(/node_modules\/electron-builder\/(?:out|dist)\//u.test(source), false,
    'vendor internal layout is not a stable build entrypoint');
  assert.equal((source.match(/npx --no-install electron-builder/gu) || []).length, 3,
    'macOS, Windows and Linux must use the pinned installed executable, not download an unpinned CLI');
  assert.match(source, /npx --no-install electron-builder --linux dir --x64 --publish never/u);
  assert.match(source, /npx --no-install electron-builder --win dir --x64 --publish never/u);
  assert.match(source, /npx --no-install electron-builder \\\n\s*--mac dir/u);
});
