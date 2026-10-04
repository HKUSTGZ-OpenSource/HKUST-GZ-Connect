'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  moduleCoverage, moduleEdgeDebtErrors, moduleImportViolations,
  moduleMapErrors, parseModuleMap, sourceInScope,
} = require('../../scripts/module-map-coverage');
const {
  architectureErrors, architectureSnapshot, moduleEdgeRatchetErrors, relativeRequires,
  buildDependencyGraph, collectJavaScriptFiles, filesInScope, JAVASCRIPT_SCOPE,
} = require('../../scripts/check-architecture');

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

test('Main composition has a narrower owner than reusable App modules', () => {
  const root = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  const map = parseModuleMap(source);
  const main = map.modules.find(module => module.id === 'desktop-main');
  const app = map.modules.find(module => module.id === 'desktop-app');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const coverage = moduleCoverage(source, files);

  assert.deepEqual(coverage.errors, []);
  assert.equal(coverage.owners['desktop/main.js'], 'desktop-main');
  assert.equal(coverage.owners['desktop/lib/app/desktop-runtime-composition.js'], 'desktop-app');
  assert.deepEqual(main.paths, ['desktop/main.js']);
  assert.deepEqual(main.publicEntrypoints, [], 'composition root is not imported by another module');
  assert.deepEqual(app.paths, ['desktop/lib/app/**']);
  assert.ok(main.allowedDependencies.includes('desktop-ipc'));
  assert.ok(main.allowedDependencies.includes('desktop-diagnostics'));
  assert.ok(!app.allowedDependencies.includes('desktop-ipc'));
  assert.ok(!app.allowedDependencies.includes('desktop-diagnostics'));
  assert.equal(map.dependencyEnforcement, 'inventory-only',
    'ownership split must not be misreported as full dependency enforcement');
});

test('static module imports distinguish undeclared edges from private entrypoints', () => {
  const f = fixture();
  f.document.modules[0].allowedDependencies = ['b'];
  const source = JSON.stringify(f.document);
  const imports = [
    ['desktop/lib/a/private.js', 'desktop/lib/b/index.js'],
    ['desktop/lib/a/private.js', 'desktop/lib/b/private.js'],
  ];
  assert.deepEqual(moduleImportViolations(source, imports), {
    errors: [],
    violations: ['desktop/lib/a/private.js -> desktop/lib/b/private.js [private-entrypoint]'],
  });
  f.document.modules[0].allowedDependencies = [];
  assert.deepEqual(moduleImportViolations(JSON.stringify(f.document), imports).violations, [
    'desktop/lib/a/private.js -> desktop/lib/b/index.js [undeclared-dependency]',
    'desktop/lib/a/private.js -> desktop/lib/b/private.js [undeclared-dependency+private-entrypoint]',
  ]);
  assert.ok(moduleImportViolations(source,
    [['desktop/lib/a/private.js', 'desktop/lib/missing/unsafe.js']]).errors
    .includes('unowned import target: desktop/lib/missing/unsafe.js'));
});

test('Main resolves exactly twenty direct edges with no private or undeclared entrypoint exception', () => {
  const root = path.resolve(__dirname, '../../..'), desktop = path.join(root, 'desktop');
  const graph = buildDependencyGraph(filesInScope(collectJavaScriptFiles(desktop), desktop, JAVASCRIPT_SCOPE.PRODUCTION));
  const imports = graph.get(path.join(desktop, 'main.js')).map(target => [
    'desktop/main.js', path.relative(root, target).replaceAll(path.sep, '/'),
  ]);
  assert.equal(imports.length, 20);
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  assert.deepEqual(moduleImportViolations(source, imports), { errors: [], violations: [] });
});

test('reviewed Main service entrypoints do not make implementation siblings or undeclared directions public', () => {
  const root = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  const entries = [
    'desktop/lib/app/card-board-main-runtime.js',
    'desktop/lib/connection/recovery/connectivity-recovery.js',
    'desktop/lib/connection/telemetry/connection-telemetry-coordinator.js',
    'desktop/lib/connection/telemetry/network-status-monitor.js',
    'desktop/lib/integrations/external-proxy-config.js',
    'desktop/lib/platform/update/update-check.js',
    'desktop/lib/profiles/runtime/school-profile-controller.js',
    'desktop/lib/switching/effects/browser-engine-barrier.js',
  ];
  const imports = entries.map(entry => ['desktop/main.js', entry]);
  assert.deepEqual(moduleImportViolations(source, imports), { errors: [], violations: [] });
  for (const entry of entries) {
    const map = parseModuleMap(source);
    const owner = map.modules.find(module => module.publicEntrypoints.includes(entry));
    assert.ok(owner, entry);
    owner.publicEntrypoints = owner.publicEntrypoints.filter(file => file !== entry);
    assert.deepEqual(moduleImportViolations(JSON.stringify(map), imports).violations,
      [`desktop/main.js -> ${entry} [private-entrypoint]`]);
  }
  for (const sibling of ['desktop/lib/app/startup/multi-school-startup-runtime.js',
    'desktop/lib/connection/recovery/health-supervisor.js',
    'desktop/lib/persistence/credentials/credential-store.js',
    'desktop/lib/profiles/registry/profile-candidate-directory.js',
    'desktop/lib/platform/storage/windows-private-file.js']) {
    assert.deepEqual(moduleImportViolations(source, [['desktop/main.js', sibling]]).violations,
      [`desktop/main.js -> ${sibling} [private-entrypoint]`]);
  }
  const map = parseModuleMap(source);
  map.modules.find(module => module.id === 'desktop-main').allowedDependencies = [];
  assert.equal(moduleImportViolations(JSON.stringify(map), imports).violations.length, entries.length);
  assert.ok(moduleImportViolations(JSON.stringify(map), imports).violations.every(value => value.endsWith('[undeclared-dependency]')));
});

test('Main cannot grandfather a private entrypoint through a matching legacy debt record', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-main-entry-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'desktop'), docs = path.join(root, 'docs', 'architecture');
  fs.mkdirSync(path.join(desktop, 'scripts'), { recursive: true }); fs.mkdirSync(docs, { recursive: true });
  const f = fixture();
  f.document.modules.push({ id: 'desktop-main', paths: ['desktop/main.js'], publicEntrypoints: [],
    allowedDependencies: ['a'], risk: 'critical', requiredChecks: ['desktop'] });
  const edge = 'desktop/main.js -> desktop/lib/a/private.js [private-entrypoint]';
  fs.writeFileSync(path.join(docs, 'module-map.yml'), JSON.stringify(f.document));
  fs.writeFileSync(path.join(desktop, 'scripts', 'module-edge-debt.json'), JSON.stringify({
    schemaVersion: 1, baseSha: 'a'.repeat(40), exceptions: [edge],
  }));
  const graph = new Map([[path.join(desktop, 'main.js'), [path.join(desktop, 'lib', 'a', 'private.js')]]]);
  assert.ok(moduleEdgeRatchetErrors(desktop, graph).includes(`Main import boundary violation: ${edge}`));
});

test('the actual shared i18n file is public for its three existing consumers, not a hidden bypass', () => {
  const root = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  const target = 'desktop/lib/platform/i18n/i18n.js';
  const imports = [
    ['desktop/main.js', target],
    ['desktop/lib/browser/session/campus-browser.js', target],
    ['desktop/lib/connection/engine/engine-output.js', target],
  ];
  assert.deepEqual(moduleImportViolations(source, imports), { errors: [], violations: [] });
  const map = parseModuleMap(source);
  map.modules.find(module => module.id === 'desktop-platform').publicEntrypoints =
    map.modules.find(module => module.id === 'desktop-platform').publicEntrypoints.filter(file => file !== target);
  assert.equal(moduleImportViolations(JSON.stringify(map), imports).violations.length, 3,
    'removing the declaration must reveal all old edges rather than silently exempting them');
  const debt = JSON.parse(fs.readFileSync(path.join(root, 'desktop/scripts/module-edge-debt.json'), 'utf8'));
  assert.equal(debt.exceptions.length, 89);
  assert.equal(debt.exceptions.includes('desktop/lib/browser/session/campus-browser.js -> desktop/lib/routing/rules/routing-rule-store.js [private-entrypoint]'), false);
  assert.ok(debt.exceptions.every(edge => !edge.includes('platform/i18n/i18n.js')));
});

test('static relative template specifiers cannot bypass the import graph', () => {
  assert.deepEqual(relativeRequires([
    'const owner = require(`../b/private.js`);',
    'const module = import(`../b/index.js`);',
    'const dollar = require(`../b/$special.js`);',
    'const computed = import(`../b/${name}.js`);',
  ].join('\n')), ['../b/private.js', '../b/index.js', '../b/$special.js']);
});

test('exact static-edge debt rejects new bypasses and stale exceptions', () => {
  const old = 'desktop/lib/a/private.js -> desktop/lib/b/private.js [private-entrypoint]';
  const next = 'desktop/lib/a/index.js -> desktop/lib/b/private.js [private-entrypoint]';
  const debt = { schemaVersion: 1, baseSha: 'a'.repeat(40), exceptions: [old] };
  assert.deepEqual(moduleEdgeDebtErrors([old], debt), []);
  assert.deepEqual(moduleEdgeDebtErrors([old, next], debt), [`new module edge bypass: ${next}`]);
  assert.deepEqual(moduleEdgeDebtErrors([], debt), [`stale module edge debt: ${old}`]);
  for (const invalid of [null, { ...debt, exceptions: [old, old] },
    { ...debt, extra: true }, { ...debt, baseSha: 'short' },
    { ...debt, exceptions: Array.from({ length: 91 }, (_, index) =>
      `desktop/lib/a/${index}.js -> desktop/lib/b/private.js [private-entrypoint]`).sort() }]) {
    assert.deepEqual(moduleEdgeDebtErrors([old], invalid), ['module edge debt manifest is invalid']);
  }
});

test('the production architecture gate includes the reviewed static-edge ratchet', () => {
  const desktopRoot = path.resolve(__dirname, '../..');
  const snapshot = architectureSnapshot(desktopRoot);
  assert.deepEqual(snapshot.moduleEdgeRatchetErrors, []);
  const failure = 'new module edge bypass: desktop/lib/a/x.js -> desktop/lib/b/y.js [private-entrypoint]';
  assert.ok(architectureErrors({ ...snapshot, moduleEdgeRatchetErrors: [failure] }).includes(failure));
  const added = new Map([[path.join(desktopRoot, 'lib/app/card-board-main-runtime.js'), [
    path.join(desktopRoot, 'lib/browser/session/campus-browser.js'),
  ]]]);
  assert.ok(moduleEdgeRatchetErrors(desktopRoot, added).some(error =>
    error.startsWith('new module edge bypass: desktop/lib/app/card-board-main-runtime.js')));
});

test('the existing campus route module is a declared file-level Routing entrypoint', () => {
  const root = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  const routing = parseModuleMap(source).modules.find(module => module.id === 'desktop-routing');
  const entry = 'desktop/lib/routing/policy/campus-route.js';
  assert.ok(routing.publicEntrypoints.includes(entry));
  assert.ok(!routing.publicEntrypoints.includes('desktop/lib/routing/rules/routing-rule-store.js'));
  assert.ok(!routing.publicEntrypoints.includes('desktop/lib/routing/policy/host-safety.js'));
  const imports = [
    ['desktop/lib/browser/session/browser-session-manager.js', entry],
    ['desktop/lib/browser/session/campus-browser-manager.js', entry],
    ['desktop/lib/browser/session/campus-browser.js', entry],
    ['desktop/lib/browser/tabs/tab-manager.js', entry],
    ['desktop/lib/browser/workspace/campus-workspace-controller.js', entry],
    ['desktop/lib/integrations/profile-network-rules.js', entry],
    ['desktop/lib/resources/runtime/campus-resources.js', entry],
    ['desktop/lib/resources/schema/campus-resource-contract.js', entry],
  ];
  assert.equal(imports.length, 8);
  assert.deepEqual(moduleImportViolations(source, imports), { errors: [], violations: [] });
  const debt = JSON.parse(fs.readFileSync(path.join(root, 'desktop/scripts/module-edge-debt.json'), 'utf8'));
  assert.ok(debt.exceptions.every(value => !value.includes(` -> ${entry} [`)));
});

test('Main certificate dispatch uses the public Browser consent entrypoint', () => {
  const root = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'docs/architecture/module-map.yml'), 'utf8');
  const browser = parseModuleMap(source).modules.find(module => module.id === 'desktop-browser');
  const entry = 'desktop/lib/browser/certificates/certificate-controller.js';
  const retired = 'desktop/lib/browser/certificates/certificate-error-boundary.js';
  assert.ok(browser.publicEntrypoints.includes(entry));
  assert.ok(!browser.publicEntrypoints.includes(
    'desktop/lib/browser/certificates/campus-certificate-trust.js'));
  assert.deepEqual(moduleImportViolations(source, [['desktop/main.js', entry]]),
    { errors: [], violations: [] });
  const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');
  const managerEntry = 'desktop/lib/browser/session/campus-browser-manager.js';
  assert.deepEqual(moduleImportViolations(source, [['desktop/main.js', managerEntry]]),
    { errors: [], violations: [] });
  assert.match(main, /require\('\.\/lib\/browser\/session\/campus-browser-manager'\)/u);
  assert.match(main, /CampusBrowserManager\.createRequestSecurityBoundary\(/u);
  const manager = fs.readFileSync(path.join(root, managerEntry), 'utf8');
  assert.match(manager, /require\('\.\.\/certificates\/certificate-controller'\)/u);
  assert.doesNotMatch(main, /certificate-error-boundary/u);
  assert.doesNotMatch(main, /require\('\.\/lib\/browser\/certificates\/campus-certificate-trust'\)/u);
  assert.equal(fs.existsSync(path.join(root, retired)), false);
  const debt = JSON.parse(fs.readFileSync(path.join(root, 'desktop/scripts/module-edge-debt.json'), 'utf8'));
  assert.ok(debt.exceptions.every(value => !value.includes(` -> ${entry} [`) &&
    !value.includes(` -> ${retired} [`)));
});
