'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  buildDependencyGraph,
  collectJavaScriptFiles,
  javascriptScope,
  JAVASCRIPT_SCOPE,
} = require('../../scripts/check-architecture');

test('Integration Center receives storage effects instead of importing Platform storage', () => {
  const desktopRoot = path.resolve(__dirname, '../..');
  const files = collectJavaScriptFiles(desktopRoot);
  const production = files.filter((file) => (
    javascriptScope(file, desktopRoot) === JAVASCRIPT_SCOPE.PRODUCTION
  ));
  const graph = buildDependencyGraph(production);
  const relative = (file) => path.relative(desktopRoot, file).replaceAll(path.sep, '/');
  const edges = [];

  for (const [source, dependencies] of graph) {
    const sourcePath = relative(source);
    if (!sourcePath.startsWith('lib/integrations/')) continue;
    for (const dependency of dependencies) {
      const dependencyPath = relative(dependency);
      if (dependencyPath.startsWith('lib/platform/storage/')) {
        edges.push(`${sourcePath} -> ${dependencyPath}`);
      }
    }
  }

  assert.deepEqual(edges, []);
});
