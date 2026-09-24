'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'e2e', 'auth-control-fixture.js'), 'utf8');

test('synthetic auth fixture binds one current context and kills its child on harness failure', () => {
  assert.match(source, /isContextCurrent:\s*\(candidate\)\s*=>\s*candidate === contextToken/u);
  assert.match(source, /registry\.bind\(9, child\.stdin, contextToken\)/u);
  assert.match(source, /main\(\)\.catch[\s\S]*activeChild\?\.kill\(\)/u);
  assert.doesNotMatch(source, /registry\.bind\(9, child\.stdin\);/u);
});
