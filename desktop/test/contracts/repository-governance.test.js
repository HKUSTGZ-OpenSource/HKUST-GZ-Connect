'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  actionPinErrors,
  governanceErrors,
  moduleMapErrors,
  relativeMarkdownTargets,
  rootTestDebtErrors,
  ROOT_TEST_DEBT_CAP,
} = require('../../../.github/scripts/check-repository-governance');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');

test('current Git index satisfies repository governance', () => {
  assert.deepEqual(governanceErrors(repositoryRoot), []);
});

test('root test debt stays at zero and cannot be reintroduced through a legacy exception', () => {
  const old = 'desktop/test/legacy.test.js';
  const replacement = 'desktop/test/new.test.js';
  const manifest = { schemaVersion: 1, rootFiles: [] };
  assert.equal(ROOT_TEST_DEBT_CAP, 0);
  assert.deepEqual(rootTestDebtErrors([], manifest), []);
  assert.deepEqual(rootTestDebtErrors([old], { schemaVersion: 1, rootFiles: [old] }),
    ['root Desktop test debt manifest is invalid']);
  assert.deepEqual(rootTestDebtErrors([replacement], manifest), [
    `new root Desktop test is forbidden: ${replacement}`,
    'root Desktop test debt grew from 0 to 1',
  ]);
  assert.deepEqual(rootTestDebtErrors(['desktop/test/unit/renderer/legacy.test.js'],
    { schemaVersion: 1, rootFiles: [] }), []);
});

test('root test placement covers alternative executable extensions and names', () => {
  for (const file of ['desktop/test/new.test.mjs', 'desktop/test/new.spec.cjs',
    'desktop/test/test-new.js', 'desktop/test/helper.js', 'desktop/test/NEW.TEST.JS']) {
    assert.ok(rootTestDebtErrors([file], { schemaVersion: 1, rootFiles: [] })
      .some(error => error.includes('new root Desktop test')), file);
  }
});

test('root test manifest rejects malformed schemas, duplicates and expanded caps', () => {
  for (const document of [null, [], { schemaVersion: 2, rootFiles: [] },
    { schemaVersion: 1, rootFiles: [], bypass: true },
    { schemaVersion: 1, rootFiles: ['../escape.js'] },
    { schemaVersion: 1, rootFiles: ['desktop/test/same.js', 'desktop/test/same.js'] },
    { schemaVersion: 1, rootFiles: Array.from({ length: ROOT_TEST_DEBT_CAP + 1 }, (_, i) => `desktop/test/test-${i}.js`) }]) {
    assert.deepEqual(rootTestDebtErrors([], document), ['root Desktop test debt manifest is invalid']);
  }
});

test('workflow actions require immutable full commit SHAs', () => {
  assert.deepEqual(actionPinErrors(
    'steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n',
    'fixture.yml',
  ), []);
  assert.deepEqual(actionPinErrors(
    'steps:\n  - uses: actions/checkout@v4\n',
    'fixture.yml',
  ), ['fixture.yml:2 action is not pinned to a full commit SHA: actions/checkout@v4']);
  assert.deepEqual(actionPinErrors('on:\n  pull_request_target:\n', 'fixture.yml'), [
    'fixture.yml uses forbidden pull_request_target',
  ]);
});

test('module map requires unique, complete module records', () => {
  const record = (id) => `  - id: ${id}\n    paths: []\n    publicEntrypoints: []\n    allowedDependencies: []\n    risk: low\n    requiredChecks: []\n`;
  const complete = `modules:\n${Array.from({ length: 10 }, (_, index) => record(`m-${index}`)).join('')}`;
  assert.deepEqual(moduleMapErrors(complete), []);
  assert.ok(moduleMapErrors(`modules:\n${record('same')}${record('same')}`).includes(
    'duplicate module id: same',
  ));
});

test('Markdown governance checks only repository-relative targets', () => {
  assert.deepEqual(relativeMarkdownTargets(
    '[local](../docs/README.md) [anchor](#title) [web](https://example.com) [root](/SECURITY.md)',
  ), [{ target: '../docs/README.md', invalidEncoding: false }]);
  assert.deepEqual(relativeMarkdownTargets('[bad](broken%ZZ.md)'), [
    { target: 'broken%ZZ.md', invalidEncoding: true },
  ]);
});
