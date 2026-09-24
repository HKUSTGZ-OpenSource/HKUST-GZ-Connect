'use strict';
// Test-only subprocess for fixture-lifecycle.test.js; no network or user data.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const mode = process.argv[3];
fs.writeFileSync(path.join(root, 'synthetic.txt'), 'fixture');
process.stdout.write('synthetic assertions: PASS\n');
if (mode === 'failure') process.exitCode = 1;
else if (mode === 'timeout') setInterval(() => {}, 1000);
else if (mode === 'flood') {
  process.stdout.write('合'.repeat(400000));
  setInterval(() => {}, 1000);
}
