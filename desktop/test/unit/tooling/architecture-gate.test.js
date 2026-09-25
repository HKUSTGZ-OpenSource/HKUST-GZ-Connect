'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BASELINE,
  JAVASCRIPT_SCOPE,
  architectureErrors,
  architectureSnapshot,
  destructuredBindingNames,
  domainDependencyErrors,
  dependencyLayerErrors,
  findCycles,
  moduleExportNames,
  namedFrozenObjectMemberNames,
  javascriptScope,
  relativeRequires,
  rootLibraryDebtErrors,
  transitiveDependencies,
  unresolvedRelativeRequireErrors,
} = require('../../../scripts/check-architecture');

test('dependency parser accepts only static relative CommonJS imports', () => {
  assert.deepEqual(relativeRequires(`
    require('./local');
    require("../shared.js");
    require('node:fs');
    require(variable);
  `), ['./local', '../shared.js']);
});

test('transitive dependency and barrel metrics expose hidden facade complexity', () => {
  const graph = new Map([
    ['main', ['facade']],
    ['facade', ['a', 'b']],
    ['a', ['b']],
    ['b', []],
  ]);
  assert.deepEqual([...transitiveDependencies(graph, 'main')].sort(), ['a', 'b', 'facade']);
  assert.deepEqual(moduleExportNames(`
    module.exports = {
      first,
      second,
    };
  `), ['first', 'second']);
  assert.deepEqual(namedFrozenObjectMemberNames(`
    const desktopRuntimeComposition = Object.freeze({
      first,
      second: implementation,
    });
  `, 'desktopRuntimeComposition'), ['first', 'second']);
  assert.deepEqual(destructuredBindingNames(`
    const { first, second: localSecond } = desktopRuntimeComposition;
  `, 'desktopRuntimeComposition'), ['first', 'second']);
});

test('production, test and support JavaScript have separate graph scopes', () => {
  const root = path.resolve('/fixture/desktop');
  for (const relativePath of [
    'main.js', 'preload.js', 'campus-preload.js', 'lib/service.js', 'renderer/app.js',
  ]) {
    assert.equal(
      javascriptScope(path.join(root, relativePath), root),
      JAVASCRIPT_SCOPE.PRODUCTION,
      relativePath,
    );
  }
  for (const relativePath of ['test/service.test.js', 'e2e/main.electron.js']) {
    assert.equal(
      javascriptScope(path.join(root, relativePath), root),
      JAVASCRIPT_SCOPE.TEST,
      relativePath,
    );
  }
  for (const relativePath of ['build/verify-package.js', 'scripts/check-architecture.js']) {
    assert.equal(
      javascriptScope(path.join(root, relativePath), root),
      JAVASCRIPT_SCOPE.SUPPORT,
      relativePath,
    );
  }
});

test('domain rules reject reverse dependencies while root legacy remains migration-compatible', () => {
  const root = path.resolve('/fixture/desktop');
  const graph = new Map([
    [path.join(root, 'lib', 'browser', 'view.js'), [
      path.join(root, 'lib', 'routing', 'policy.js'),
      path.join(root, 'lib', 'persistence', 'migration.js'),
    ]],
    [path.join(root, 'lib', 'legacy.js'), [path.join(root, 'lib', 'browser', 'view.js')]],
  ]);
  assert.deepEqual(domainDependencyErrors(graph, root), [
    'domain violation: lib/browser/view.js -> lib/persistence/migration.js',
  ]);
});

test('root debt rejects additions and requires explicit ratcheting after moves', () => {
  assert.deepEqual(rootLibraryDebtErrors(['a.js', 'new.js'], ['a.js', 'old.js']), [
    'architecture root debt was not ratcheted after moving: old.js',
    'new desktop/lib root file is forbidden: new.js',
  ]);
});

test('cycle detection reports a closed dependency path', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
  ]);
  assert.deepEqual(findCycles(graph), [['a', 'b', 'c', 'a']]);
});

test('full graph cycle detection catches cycles crossing test and support scopes', () => {
  const testFile = '/fixture/desktop/test/helper.test.js';
  const supportFile = '/fixture/desktop/scripts/helper.js';
  const fullGraph = new Map([
    [testFile, [supportFile]],
    [supportFile, [testFile]],
  ]);
  // Scope-only graphs intentionally omit edges whose targets live outside the
  // scope. The authoritative full graph must therefore retain its own cycle
  // gate in addition to the per-scope diagnostics.
  assert.deepEqual(findCycles(new Map([[testFile, []]])), []);
  assert.deepEqual(findCycles(new Map([[supportFile, []]])), []);
  assert.deepEqual(findCycles(fullGraph), [[testFile, supportFile, testFile]]);
});

test('unresolved static relative imports fail the architecture gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-require-'));
  const source = path.join(root, 'lib', 'source.js');
  try {
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, "require('./missing');\n");
    assert.deepEqual(unresolvedRelativeRequireErrors([source], root), [
      'unresolved relative require: lib/source.js -> ./missing',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production dependency layers reject reverse imports into renderer, tests or build code', () => {
  const root = path.resolve('/fixture/desktop');
  const graph = new Map([
    [path.join(root, 'main.js'), [path.join(root, 'lib', 'service.js')]],
    [path.join(root, 'lib', 'service.js'), [path.join(root, 'renderer', 'app.js')]],
    [path.join(root, 'renderer', 'feature.js'), [path.join(root, 'test', 'fixture.js')]],
  ]);
  assert.deepEqual(dependencyLayerErrors(graph, root), [
    'layer violation: lib/service.js -> renderer/app.js',
    'layer violation: renderer/feature.js -> test/fixture.js',
  ]);
});

test('current production graph has no cycle and stays within debt growth caps', () => {
  const snapshot = architectureSnapshot(path.join(__dirname, '..', '..', '..'));
  assert.deepEqual(architectureErrors(snapshot), []);
  assert.equal(snapshot.cycles.length, 0);
  assert.equal(snapshot.allCycles.length, 0);
  assert.deepEqual(snapshot.layerErrors, []);
  assert.deepEqual(snapshot.unresolvedRequireErrors, []);
  assert.equal(
    snapshot.productionFileCount + snapshot.testFileCount + snapshot.supportFileCount,
    snapshot.fileCount,
  );
  assert.ok(snapshot.productionFileCount > 0);
  assert.ok(snapshot.productionEdgeCount > 0);
  assert.ok(snapshot.testFileCount > 0);
  assert.ok(snapshot.testEdgeCount > 0);
  assert.ok(snapshot.supportFileCount > 0);
  assert.ok(snapshot.supportEdgeCount > 0);
  assert.equal(snapshot.testCycles.length, 0);
  assert.equal(snapshot.supportCycles.length, 0);
  assert.ok(snapshot.mainDirectDependencies <= BASELINE.mainDirectDependencies);
  assert.ok(snapshot.mainTransitiveDependencies <= BASELINE.mainTransitiveDependencies);
  assert.ok(snapshot.mainLines <= BASELINE.mainLines);
  assert.ok(snapshot.rendererLines <= BASELINE.rendererLines);
  assert.ok(snapshot.libMaxFanIn <= BASELINE.libMaxFanIn);
  assert.ok(snapshot.libMaxFanOut <= BASELINE.libMaxFanOut);
  assert.ok(snapshot.runtimeCompositionExports <= BASELINE.runtimeCompositionExports);
  assert.ok(snapshot.runtimeCompositionMembers <= BASELINE.runtimeCompositionMembers);
  assert.ok(snapshot.mainCompositionBindings <= BASELINE.mainCompositionBindings);
  assert.ok(
    snapshot.mainEffectiveDirectDependencies <= BASELINE.mainEffectiveDirectDependencies,
  );
  assert.ok(snapshot.mainCompositionBindings <= snapshot.runtimeCompositionMembers);
  assert.deepEqual(snapshot.domainLayerErrors, []);
  assert.deepEqual(snapshot.rootLibraryDebtErrors, []);
});

test('growth beyond any explicit baseline fails the gate', () => {
  const snapshot = {
    cycles: [],
    testCycles: [],
    supportCycles: [],
    mainDirectDependencies: BASELINE.mainDirectDependencies + 1,
    mainTransitiveDependencies: BASELINE.mainTransitiveDependencies + 1,
    mainLines: BASELINE.mainLines + 1,
    rendererLines: BASELINE.rendererLines + 1,
    libMaxFanIn: BASELINE.libMaxFanIn + 1,
    libMaxFanOut: BASELINE.libMaxFanOut + 1,
    runtimeCompositionExports: BASELINE.runtimeCompositionExports + 1,
    runtimeCompositionMembers: BASELINE.runtimeCompositionMembers + 1,
    mainCompositionBindings: BASELINE.mainCompositionBindings + 1,
    mainEffectiveDirectDependencies: BASELINE.mainEffectiveDirectDependencies + 1,
  };
  assert.deepEqual(architectureErrors(snapshot), [
    `mainDirectDependencies grew from ${BASELINE.mainDirectDependencies} to ${snapshot.mainDirectDependencies}`,
    `mainTransitiveDependencies grew from ${BASELINE.mainTransitiveDependencies} to ${snapshot.mainTransitiveDependencies}`,
    `mainLines grew from ${BASELINE.mainLines} to ${snapshot.mainLines}`,
    `rendererLines grew from ${BASELINE.rendererLines} to ${snapshot.rendererLines}`,
    `libMaxFanIn grew from ${BASELINE.libMaxFanIn} to ${snapshot.libMaxFanIn}`,
    `libMaxFanOut grew from ${BASELINE.libMaxFanOut} to ${snapshot.libMaxFanOut}`,
    `runtimeCompositionExports grew from ${BASELINE.runtimeCompositionExports} to ${snapshot.runtimeCompositionExports}`,
    `runtimeCompositionMembers grew from ${BASELINE.runtimeCompositionMembers} to ${snapshot.runtimeCompositionMembers}`,
    `mainCompositionBindings grew from ${BASELINE.mainCompositionBindings} to ${snapshot.mainCompositionBindings}`,
    `mainEffectiveDirectDependencies grew from ${BASELINE.mainEffectiveDirectDependencies} to ${snapshot.mainEffectiveDirectDependencies}`,
  ]);
});
