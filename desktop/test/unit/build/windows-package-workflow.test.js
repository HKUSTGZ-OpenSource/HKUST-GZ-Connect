'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const desktop = path.resolve(__dirname, '..', '..', '..');
const workflow = fs.readFileSync(path.join(desktop, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));

function windowsPackageJob(source) {
  const lines = source.split('\n');
  const start = lines.indexOf('  package-verifier-platform:');
  assert(start >= 0, 'the required package-verifier platform job must exist');
  const next = lines.findIndex((line, index) => index > start && /^  [\w-]+:/u.test(line));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
}

function assertHelperBuildBeforePackage(source) {
  const job = windowsPackageJob(source);
  const starts = [...job.matchAll(/^      - /gmu)].map(match => match.index);
  const steps = starts.map((start, index) => job.slice(start, starts[index + 1] ?? job.length));
  const install = steps.findIndex(step => /^        run: npm ci\s*$/mu.test(step));
  const helper = steps.findIndex(step => /^        run: npm run build:windows-private-file\s*$/mu.test(step));
  const pack = steps.findIndex(step => /^        run: .*electron-builder.* --win dir --x64 --publish never\s*$/mu.test(step));
  assert(install >= 0 && helper > install && pack > helper,
    'same job must install dependencies and build the Windows ACL helper before direct electron-builder');
  assert.match(steps[helper], /^        if: matrix\.platform == 'windows'\s*$/mu);
  assert.match(steps[pack], /^        if: matrix\.platform == 'windows'\s*$/mu);
  assert.match(job, /defaults:\n      run:\n        working-directory: desktop/u);
  assert.doesNotMatch(steps[helper], /working-directory:|continue-on-error:/u);
}

test('clean Windows package CI explicitly builds the required private-file helper', () => {
  assertHelperBuildBeforePackage(workflow);
  assert.equal(manifest.scripts['build:windows-private-file'], 'node scripts/build-windows-private-file.js');
});

test('ordering contract rejects missing, late, or wrong-platform helper builds', () => {
  const helper = "      - name: Build Windows private-file helper\n        if: matrix.platform == 'windows'\n        run: npm run build:windows-private-file\n";
  const packageStep = "      - name: Package\n        if: matrix.platform == 'windows'\n        run: node node_modules/electron-builder/out/cli/cli.js --win dir --x64 --publish never\n";
  const prefix = 'jobs:\n  package-verifier-platform:\n    defaults:\n      run:\n        working-directory: desktop\n    steps:\n      - name: Install\n        run: npm ci\n';
  assert.doesNotThrow(() => assertHelperBuildBeforePackage(prefix + helper + packageStep));
  assert.throws(() => assertHelperBuildBeforePackage(prefix + packageStep));
  assert.throws(() => assertHelperBuildBeforePackage(prefix + packageStep + helper));
  assert.throws(() => assertHelperBuildBeforePackage(prefix + helper.replace("== 'windows'", "== 'linux'") + packageStep));
  assert.throws(() => assertHelperBuildBeforePackage(prefix + helper.replace('        run:', '        continue-on-error: true\n        run:') + packageStep));
});
