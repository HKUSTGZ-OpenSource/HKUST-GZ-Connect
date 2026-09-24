'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { moduleCoverage, moduleMapErrors, parseModuleMap, sourceInScope } = require('../../scripts/module-map-coverage');

function fixture() {
  const record = id => ({ id, paths: [`desktop/lib/${id}/**`],
    publicEntrypoints: [`desktop/lib/${id}/index.js`], allowedDependencies: [],
    risk: 'high', requiredChecks: ['desktop'] });
  const document = { schemaVersion: 2, status: 'proposed', owner: 'maintainers', lastVerified: '2026-09-07',
    enforcement: 'path-coverage-and-entrypoint-ownership', dependencyEnforcement: 'inventory-only',
    modules: [record('a'), record('b')] };
  const files = ['desktop/lib/a/index.js', 'desktop/lib/a/private.js', 'desktop/lib/b/index.js'];
  return { document, files, check: () => moduleCoverage(JSON.stringify(document), files) };
}

test('every in-scope file has exactly one named owner and entries belong to that owner', () => {
  const f = fixture();
  assert.deepEqual(f.check(), { errors: [], sourceCount: 3, owners: {
    'desktop/lib/a/index.js': 'a', 'desktop/lib/a/private.js': 'a', 'desktop/lib/b/index.js': 'b',
  } });
});

test('missing source ownership fails independently of public-entrypoint completeness', () => {
  const f = fixture();
  f.files.push('desktop/lib/missing/secret-owner.js');
  assert.ok(f.check().errors.includes('unowned production path: desktop/lib/missing/secret-owner.js'));
  assert.equal(sourceInScope('independent/src/bin/new-tool.rs'), true);
  assert.equal(sourceInScope('desktop/renderer/features/new/index.mjs'), true);
  assert.equal(sourceInScope('desktop/assets/profiles/new/school-profile.json'), true);
  assert.equal(sourceInScope('tools/mac-cli/new.sh'), true);
  assert.equal(sourceInScope('hkustgzconnect'), true);
  assert.equal(sourceInScope('desktop/test/unit/example.test.js'), false);
});

test('overlapping glob ownership is rejected even without a currently matching file', () => {
  const f = fixture();
  f.document.modules[1].paths = ['desktop/lib/a/future/**'];
  f.document.modules[1].publicEntrypoints = [];
  assert.ok(f.check().errors.some(error => error.startsWith('overlapping module paths')));
  f.document.modules[1].paths = ['desktop/lib/a/private.js'];
  assert.ok(f.check().errors.some(error => error.startsWith('overlapping module paths')));
  f.document.modules[1].paths = ['desktop/lib/ab/**'];
  assert.ok(!moduleMapErrors(JSON.stringify(f.document)).some(error => error.startsWith('overlapping')),
    'path-component prefixes are not directory overlap');
});

test('entrypoints must exist in the tracked inventory and cannot belong to another owner', () => {
  const f = fixture();
  f.document.modules[0].publicEntrypoints = ['desktop/lib/a/absent.js'];
  assert.ok(f.check().errors.some(error => error.startsWith('missing public entrypoint')));
  f.document.modules[0].publicEntrypoints = ['desktop/lib/b/index.js'];
  assert.ok(f.check().errors.some(error => error.startsWith('public entrypoint outside owner')));
});

test('retired paths and empty coverage cannot silently pass', () => {
  const f = fixture();
  f.document.modules[0].paths.push('desktop/lib/a-retired/**');
  assert.ok(f.check().errors.some(error => error.startsWith('stale module path')));
  assert.ok(moduleCoverage(JSON.stringify(f.document), []).errors.includes('module coverage contains no production paths'));
});

test('required check typos and invented checks cannot qualify a module', () => {
  for (const name of ['desktpo', 'imaginary-security-check', 'desktop-electrons']) {
    const f = fixture();
    f.document.modules[0].requiredChecks = [name];
    assert.ok(f.check().errors.length, `unknown required check must fail: ${name}`);
  }
});

test('schema refuses hidden fields, wrong types, invalid paths and unknown dependency names', () => {
  for (const change of [
    d => { d.schemaVersion = 1; }, d => { d.sourceScopes = []; },
    d => { d.modules[0].paths = ['../escape/**']; },
    d => { d.modules[0].paths = ['desktop/lib/*']; },
    d => { d.modules[0].paths = ['desktop/lib/**', 'desktop/lib/**']; },
    d => { d.modules[0].paths = ['desktop\\lib\\a']; },
    d => { d.modules[0].risk = 'safe'; },
    d => { d.modules[0].requiredChecks = []; },
    d => { d.modules[0].allowedDependencies = ['missing']; },
    d => { d.modules[0].publicEntrypoints = ['https://example.invalid/api']; },
    d => { d.modules[0].ignored = true; },
    d => { d.owner = null; },
  ]) {
    const f = fixture(); change(f.document);
    assert.ok(f.check().errors.length);
  }
});

test('YAML duplicate fields, unsafe tags and malformed data fail closed', () => {
  for (const source of ['schemaVersion: 2\nschemaVersion: 2',
    '!!js/function function () {}', 'modules: [', 'x'.repeat(128 * 1024 + 1)]) {
    assert.deepEqual(moduleMapErrors(source), ['module map YAML is invalid']);
  }
  assert.equal(parseModuleMap('lastVerified: 2026-09-07').lastVerified, '2026-09-07');
});

test('malformed or duplicate file inventories cannot qualify coverage', () => {
  const source = JSON.stringify(fixture().document);
  for (const files of [null, ['../escape.js'], ['desktop/lib/a/index.js', 'desktop/lib/a/index.js']]) {
    assert.ok(moduleCoverage(source, files).errors.includes('module coverage file inventory is invalid'));
  }
});

test('Unicode and spaced filenames remain valid tracked paths under an owned directory', () => {
  const f = fixture();
  f.files.push('desktop/lib/a/课程 模型.js', 'docs/中文说明.md');
  assert.deepEqual(f.check().errors, []);
  f.document.modules[0].publicEntrypoints.push('desktop/lib/a/课程 模型.js');
  assert.deepEqual(f.check().errors, []);
});

test('actual repository inventory is covered without treating the dependency inventory as enforcement', () => {
  const root = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const result = moduleCoverage(source, files);
  assert.deepEqual(result.errors, []);
  assert.ok(result.sourceCount > 250);
  assert.equal(Object.keys(result.owners).length, result.sourceCount);
  assert.equal(parseModuleMap(source).dependencyEnforcement, 'inventory-only');
  assert.equal(result.owners['desktop/lib/ipc/ipc-handlers.js'], 'desktop-ipc');
  assert.equal(result.owners['independent/src/bin/ec-proxy-command.rs'], 'engine-helpers');
  assert.equal(result.owners['independent/src/bin/ec-auth-fixture.rs'], 'engine-test-support');
});
