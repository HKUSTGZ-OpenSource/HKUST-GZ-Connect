'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildDependencyGraph, collectJavaScriptFiles } = require('../../scripts/check-architecture');
const { parseModuleMap } = require('../../scripts/module-map-coverage');

test('Profile storage is Main-injected through the mapped Platform entrypoint', () => {
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const desktopRoot = path.join(repositoryRoot, 'desktop');
  const moduleMap = parseModuleMap(fs.readFileSync(
    path.join(repositoryRoot, 'docs/architecture/module-map.yml'), 'utf8',
  ));
  const platform = moduleMap.modules.find((module) => module.id === 'desktop-platform');
  const entrypoint = 'desktop/lib/platform/storage/private-file.js';
  const files = collectJavaScriptFiles(desktopRoot);
  const graph = buildDependencyGraph(files);
  const relative = (file) => path.relative(desktopRoot, file).replaceAll(path.sep, '/');
  const storageOwnerEdges = [];

  for (const [source, targets] of graph) {
    const sourcePath = relative(source);
    if (!sourcePath.startsWith('lib/profiles/') && !sourcePath.startsWith('lib/switching/')) continue;
    for (const target of targets) {
      const targetPath = relative(target);
      if (targetPath.startsWith('lib/platform/storage/')) {
        storageOwnerEdges.push(`${sourcePath} -> ${targetPath}`);
      }
    }
  }

  const main = path.join(desktopRoot, 'main.js');
  const mainImportsStorageEntrypoint = (graph.get(main) || []).includes(
    path.join(desktopRoot, 'lib/platform/storage/private-file.js'),
  );
  const errors = [];
  if (!platform?.publicEntrypoints.includes(entrypoint)) {
    errors.push(`Platform public entrypoint is missing: ${entrypoint}`);
  }
  if (!mainImportsStorageEntrypoint) errors.push('Main must construct effects from the existing storage import');
  if (storageOwnerEdges.length) {
    errors.push(`Profiles/Switching retain ${storageOwnerEdges.length} private storage imports: ${storageOwnerEdges.join('; ')}`);
  }
  assert.deepEqual(errors, []);
});
