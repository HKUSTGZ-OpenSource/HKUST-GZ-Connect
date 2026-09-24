'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { checkRendererBoundaries } = require('./renderer-boundaries');
const RENDERER_SHARED_SOURCES = Object.freeze([
  'lib/browser/auth/login-flow.js',
  'lib/resources/presentation/resource-view.js',
]);

// These are growth caps, not target sizes. They make the current debt explicit
// and prevent another feature from enlarging either God Module while the code
// is extracted incrementally behind tests.
const BASELINE = Object.freeze({
  // One direct/transitive module was added for the reviewed one-shot Linux
  // credential boundary. Main simultaneously stopped consuming four facade
  // bindings, so the effective semantic dependency cap below still shrank.
  mainDirectDependencies: 36,
  // The cross-platform network-environment domain now owns one additional
  // HTTPS-only public-egress leaf. Main gained no direct dependency or lines.
  // Card Board adds one isolated App composition and four bounded layout
  // modules without adding another direct Main binding.
  // The myPortal catalog is one isolated Browser-domain leaf behind the existing
  // Main binding; no direct dependency, composition member, or Main line was added.
  mainTransitiveDependencies: 170,
  // This transition cap includes the disconnected-session recovery, async
  // platform discovery, one-shot credential security closures and the reviewed
  // service-desk hand-off. Further feature work must extract responsibilities
  // instead of growing Main again.
  mainLines: 1720,
  rendererLines: 564,
  // Production-only fan-in. Test, E2E, build and maintenance imports are
  // reported separately and must not make the runtime graph look denser.
  libMaxFanIn: 33,
  libMaxFanOut: 14,
  runtimeCompositionExports: 1,
  runtimeCompositionMembers: 20,
  mainCompositionBindings: 16,
  mainEffectiveDirectDependencies: 51,
});

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'release']);
const JAVASCRIPT_SCOPE = Object.freeze({
  PRODUCTION: 'production',
  TEST: 'test',
  SUPPORT: 'support',
});
const DOMAIN_DEPENDENCIES = Object.freeze({
  app: Object.freeze(['app', 'connection', 'profiles', 'profile-core', 'persistence', 'switching', 'browser',
    'resources', 'resource-core', 'card-board', 'routing', 'integrations', 'ipc', 'platform', 'diagnostics', 'legacy']),
  connection: Object.freeze(['connection', 'network-environment', 'profiles', 'profile-core', 'platform', 'diagnostics', 'legacy']),
  'network-environment': Object.freeze(['network-environment', 'platform', 'diagnostics', 'legacy']),
  'profile-core': Object.freeze(['profile-core', 'resource-core', 'platform', 'diagnostics', 'legacy']),
  profiles: Object.freeze(['profiles', 'profile-core', 'persistence', 'resources', 'resource-core',
    'routing', 'platform', 'diagnostics', 'legacy']),
  persistence: Object.freeze(['persistence', 'profile-core', 'resource-core', 'routing', 'platform',
    'diagnostics', 'legacy']),
  switching: Object.freeze(['switching', 'persistence', 'connection', 'browser', 'profiles', 'profile-core',
    'platform', 'diagnostics', 'legacy']),
  browser: Object.freeze(['browser', 'resources', 'resource-core', 'routing', 'profiles', 'profile-core',
    'platform', 'diagnostics', 'legacy']),
  'resource-core': Object.freeze(['resource-core', 'routing', 'platform', 'diagnostics', 'legacy']),
  resources: Object.freeze(['resources', 'resource-core', 'routing', 'profiles', 'profile-core',
    'platform', 'diagnostics', 'legacy']),
  'card-board': Object.freeze(['card-board', 'platform', 'diagnostics', 'legacy']),
  routing: Object.freeze(['routing', 'profiles', 'profile-core', 'platform', 'diagnostics', 'legacy']),
  integrations: Object.freeze(['integrations', 'resources', 'resource-core', 'routing', 'profiles',
    'profile-core', 'connection', 'platform', 'diagnostics', 'legacy']),
  ipc: Object.freeze(['ipc', 'connection', 'profiles', 'profile-core', 'persistence', 'switching', 'browser',
    'card-board', 'routing', 'integrations', 'platform', 'diagnostics', 'legacy']),
  platform: Object.freeze(['platform', 'diagnostics', 'legacy']),
  diagnostics: Object.freeze(['diagnostics', 'platform', 'legacy']),
});

function collectJavaScriptFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
      } else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) {
        files.push(path.resolve(directory, entry.name));
      }
    }
  };
  visit(path.resolve(root));
  return files.sort();
}

function relativeJavaScriptPath(file, root) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function javascriptScope(file, root) {
  const relativePath = relativeJavaScriptPath(file, root);
  if (relativePath === 'main.js' || relativePath === 'preload.js' ||
      relativePath === 'campus-preload.js' || relativePath.startsWith('lib/') ||
      relativePath.startsWith('renderer/')) {
    return JAVASCRIPT_SCOPE.PRODUCTION;
  }
  if (relativePath.startsWith('test/') || relativePath.startsWith('e2e/')) {
    return JAVASCRIPT_SCOPE.TEST;
  }
  return JAVASCRIPT_SCOPE.SUPPORT;
}

function filesInScope(files, root, scope) {
  return files.filter((file) => javascriptScope(file, root) === scope);
}

function edgeCount(graph) {
  return [...graph.values()].reduce((total, dependencies) => total + dependencies.length, 0);
}

function edgeCountForSources(graph, sources) {
  return [...sources].reduce((total, source) => total + (graph.get(source)?.length || 0), 0);
}

function relativeRequires(source) {
  return [...String(source).matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...String(source).matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gm)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'));
}

function resolveLocalModule(fromFile, specifier, files) {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  for (const resolved of [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]) {
    if (files.has(resolved)) return resolved;
  }
  return null;
}

function buildDependencyGraph(files) {
  const fileSet = new Set(files.map((file) => path.resolve(file)));
  const graph = new Map();
  for (const file of fileSet) {
    const dependencies = relativeRequires(fs.readFileSync(file, 'utf8'))
      .map((specifier) => resolveLocalModule(file, specifier, fileSet))
      .filter(Boolean);
    graph.set(file, [...new Set(dependencies)].sort());
  }
  return graph;
}

function unresolvedRelativeRequireErrors(files, root) {
  const fileSet = new Set(files.map((file) => path.resolve(file)));
  const errors = [];
  for (const file of fileSet) {
    const relativeFile = path.relative(root, file).replaceAll(path.sep, '/');
    const productionSource = relativeFile === 'main.js' || relativeFile === 'preload.js' ||
      relativeFile === 'campus-preload.js' || relativeFile.startsWith('lib/') ||
      relativeFile.startsWith('renderer/');
    if (!productionSource) continue;
    for (const specifier of relativeRequires(fs.readFileSync(file, 'utf8'))) {
      if (resolveLocalModule(file, specifier, fileSet)) continue;
      errors.push(`unresolved relative require: ${relativeFile} -> ${specifier}`);
    }
  }
  return errors.sort();
}

function findCycles(graph) {
  const state = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  const visit = (node) => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const dependency of graph.get(node) || []) {
      if (!state.has(dependency)) {
        visit(dependency);
      } else if (state.get(dependency) === 'visiting') {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        const identity = [...new Set(cycle.slice(0, -1))].sort().join('\n');
        if (!seen.has(identity)) {
          seen.add(identity);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    state.set(node, 'visited');
  };

  for (const node of graph.keys()) {
    if (!state.has(node)) visit(node);
  }
  return cycles;
}

function lineCount(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source) return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function transitiveDependencies(graph, start) {
  const visited = new Set();
  const visit = (node) => {
    for (const dependency of graph.get(node) || []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      visit(dependency);
    }
  };
  visit(start);
  return visited;
}

function graphFanMetrics(graph, root) {
  const fanIn = new Map([...graph.keys()].map((file) => [file, 0]));
  for (const dependencies of graph.values()) {
    for (const dependency of dependencies) fanIn.set(dependency, (fanIn.get(dependency) || 0) + 1);
  }
  const library = [...graph.keys()].filter((file) => (
    path.relative(root, file).replaceAll(path.sep, '/').startsWith('lib/')
  ));
  return Object.freeze({
    libMaxFanIn: Math.max(0, ...library.map((file) => fanIn.get(file) || 0)),
    libMaxFanOut: Math.max(0, ...library.map((file) => graph.get(file)?.length || 0)),
  });
}

function moduleExportNames(source) {
  const match = String(source).match(/module\.exports\s*=\s*\{([\s\S]*?)\};/u);
  if (!match) return Object.freeze([]);
  const names = [...match[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gmu)]
    .map((value) => value[1]);
  return Object.freeze([...new Set(names)].sort());
}

function topLevelCommaItems(source) {
  const items = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] || ',';
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      const item = source.slice(start, index).trim();
      if (item) items.push(item);
      start = index + 1;
    }
  }
  return Object.freeze(items);
}

function namedFrozenObjectMemberNames(source, bindingName) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(bindingName)) return Object.freeze([]);
  const escapedName = bindingName.replace(/[$]/gu, '\\$&');
  const match = String(source).match(new RegExp(
    `const\\s+${escapedName}\\s*=\\s*Object\\.freeze\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\);`,
    'u',
  ));
  if (!match) return Object.freeze([]);
  const names = topLevelCommaItems(match[1]).map((item) => {
    const normalized = item.replace(/\/\*[\s\S]*?\*\//gu, '').trim();
    if (normalized.startsWith('...')) return normalized;
    return normalized.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/u)?.[1] || normalized;
  });
  return Object.freeze([...new Set(names)].sort());
}

function destructuredBindingNames(source, bindingName) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(bindingName)) return Object.freeze([]);
  const escapedName = bindingName.replace(/[$]/gu, '\\$&');
  const match = String(source).match(new RegExp(
    `const\\s*\\{([^{}]*)\\}\\s*=\\s*${escapedName}\\s*;`,
    'u',
  ));
  if (!match) return Object.freeze([]);
  const names = topLevelCommaItems(match[1]).map((item) => (
    item.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|=|$)/u)?.[1] || item.trim()
  ));
  return Object.freeze([...new Set(names)].sort());
}

function rootLibraryFiles(root) {
  const library = path.join(root, 'lib');
  return Object.freeze(fs.readdirSync(library, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort());
}

function loadRootLibraryDebt(root) {
  const debtPath = path.join(root, 'scripts', 'architecture-root-debt.json');
  const value = JSON.parse(fs.readFileSync(debtPath, 'utf8'));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.rootFiles) ||
      value.rootFiles.some((file) => typeof file !== 'string' || !/^[a-z0-9-]+\.js$/u.test(file)) ||
      new Set(value.rootFiles).size !== value.rootFiles.length) {
    throw new TypeError('architecture root debt has an invalid schema');
  }
  return Object.freeze([...value.rootFiles].sort());
}

function rootLibraryDebtErrors(current, expected) {
  const actualSet = new Set(current);
  const expectedSet = new Set(expected);
  return Object.freeze([
    ...current.filter((file) => !expectedSet.has(file))
      .map((file) => `new desktop/lib root file is forbidden: ${file}`),
    ...expected.filter((file) => !actualSet.has(file))
      .map((file) => `architecture root debt was not ratcheted after moving: ${file}`),
  ].sort());
}

function productionDomain(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  if (normalized.startsWith('lib/profiles/schema/')) return 'profile-core';
  if (normalized.startsWith('lib/resources/schema/')) return 'resource-core';
  const match = normalized.match(/^lib\/([^/]+)\//u);
  if (!match) return normalized.startsWith('lib/') ? 'legacy' : null;
  return Object.hasOwn(DOMAIN_DEPENDENCIES, match[1]) ? match[1] : 'unknown';
}

function domainDependencyErrors(graph, root) {
  const errors = [];
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/');
  for (const [source, dependencies] of graph) {
    const sourcePath = relative(source);
    const sourceDomain = productionDomain(sourcePath);
    if (!sourceDomain || sourceDomain === 'legacy') continue;
    if (sourceDomain === 'unknown') {
      errors.push(`unknown desktop domain: ${sourcePath}`);
      continue;
    }
    const allowed = new Set(DOMAIN_DEPENDENCIES[sourceDomain]);
    for (const dependency of dependencies) {
      const dependencyPath = relative(dependency);
      const dependencyDomain = productionDomain(dependencyPath);
      if (dependencyDomain && !allowed.has(dependencyDomain)) {
        errors.push(`domain violation: ${sourcePath} -> ${dependencyPath}`);
      }
    }
  }
  return errors.sort();
}

function dependencyLayerErrors(graph, root) {
  const errors = [];
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/');
  const browserShared = new Set(RENDERER_SHARED_SOURCES);
  for (const [source, dependencies] of graph) {
    const sourcePath = relative(source);
    const productionSource = sourcePath === 'main.js' || sourcePath === 'preload.js' ||
      sourcePath === 'campus-preload.js' || sourcePath.startsWith('lib/') ||
      sourcePath.startsWith('renderer/');
    if (!productionSource) continue;
    for (const dependency of dependencies) {
      const dependencyPath = relative(dependency);
      let allowed = true;
      if (sourcePath === 'main.js' || sourcePath === 'preload.js' ||
          sourcePath === 'campus-preload.js' || sourcePath.startsWith('lib/')) {
        allowed = dependencyPath.startsWith('lib/');
      } else if (sourcePath.startsWith('renderer/')) {
        allowed = dependencyPath.startsWith('renderer/') || browserShared.has(dependencyPath);
      }
      if (!allowed) errors.push(`layer violation: ${sourcePath} -> ${dependencyPath}`);
    }
  }
  return errors.sort();
}

function architectureSnapshot(root = path.resolve(__dirname, '..')) {
  const files = collectJavaScriptFiles(root);
  const productionFiles = filesInScope(files, root, JAVASCRIPT_SCOPE.PRODUCTION);
  const testFiles = filesInScope(files, root, JAVASCRIPT_SCOPE.TEST);
  const supportFiles = filesInScope(files, root, JAVASCRIPT_SCOPE.SUPPORT);
  const graph = buildDependencyGraph(files);
  const productionGraph = buildDependencyGraph(productionFiles);
  const testGraph = buildDependencyGraph(testFiles);
  const supportGraph = buildDependencyGraph(supportFiles);
  const mainFile = path.join(root, 'main.js');
  const rendererFile = path.join(root, 'renderer', 'app.js');
  const runtimeCompositionFile = path.join(root, 'lib', 'app', 'desktop-runtime-composition.js');
  const mainSource = fs.readFileSync(mainFile, 'utf8');
  const runtimeCompositionSource = fs.readFileSync(runtimeCompositionFile, 'utf8');
  const runtimeCompositionMembers = namedFrozenObjectMemberNames(
    runtimeCompositionSource,
    'desktopRuntimeComposition',
  ).length;
  const mainCompositionBindings = destructuredBindingNames(
    mainSource,
    'desktopRuntimeComposition',
  ).length;
  const rootFiles = rootLibraryFiles(root);
  const rootDebt = loadRootLibraryDebt(root);
  const fan = graphFanMetrics(productionGraph, root);
  const mainDirectDependencies = productionGraph.get(mainFile)?.length || 0;
  return {
    allCycles: findCycles(graph),
    cycles: findCycles(productionGraph),
    testCycles: findCycles(testGraph),
    supportCycles: findCycles(supportGraph),
    unresolvedRequireErrors: unresolvedRelativeRequireErrors(files, root),
    rendererBoundaryErrors: checkRendererBoundaries(root, files, RENDERER_SHARED_SOURCES),
    layerErrors: dependencyLayerErrors(graph, root),
    domainLayerErrors: domainDependencyErrors(graph, root),
    rootLibraryDebtErrors: rootLibraryDebtErrors(rootFiles, rootDebt),
    edgeCount: edgeCount(graph),
    fileCount: files.length,
    productionFileCount: productionFiles.length,
    productionEdgeCount: edgeCount(productionGraph),
    testFileCount: testFiles.length,
    testEdgeCount: edgeCountForSources(graph, testFiles),
    supportFileCount: supportFiles.length,
    supportEdgeCount: edgeCountForSources(graph, supportFiles),
    mainDirectDependencies,
    mainTransitiveDependencies: transitiveDependencies(productionGraph, mainFile).size,
    mainLines: lineCount(mainFile),
    rendererLines: lineCount(rendererFile),
    runtimeCompositionExports: moduleExportNames(
      runtimeCompositionSource,
    ).length,
    runtimeCompositionMembers,
    mainCompositionBindings,
    mainEffectiveDirectDependencies: mainDirectDependencies +
      Math.max(0, mainCompositionBindings - 1),
    rootLibraryFileCount: rootFiles.length,
    ...fan,
  };
}

function architectureErrors(snapshot) {
  const errors = [];
  if (snapshot.allCycles?.length) errors.push(`all-scope CommonJS cycles: ${snapshot.allCycles.length}`);
  if (snapshot.cycles.length) errors.push(`production CommonJS cycles: ${snapshot.cycles.length}`);
  if (snapshot.testCycles?.length) errors.push(`test CommonJS cycles: ${snapshot.testCycles.length}`);
  if (snapshot.supportCycles?.length) {
    errors.push(`support CommonJS cycles: ${snapshot.supportCycles.length}`);
  }
  errors.push(...(snapshot.unresolvedRequireErrors || []));
  errors.push(...(snapshot.rendererBoundaryErrors || []));
  errors.push(...(snapshot.layerErrors || []));
  errors.push(...(snapshot.domainLayerErrors || []));
  errors.push(...(snapshot.rootLibraryDebtErrors || []));
  for (const key of [
    'mainDirectDependencies', 'mainTransitiveDependencies', 'mainLines', 'rendererLines',
    'libMaxFanIn', 'libMaxFanOut', 'runtimeCompositionExports',
    'runtimeCompositionMembers', 'mainCompositionBindings',
    'mainEffectiveDirectDependencies',
  ]) {
    if (!Number.isFinite(snapshot[key])) continue;
    if (snapshot[key] > BASELINE[key]) {
      errors.push(`${key} grew from ${BASELINE[key]} to ${snapshot[key]}`);
    }
  }
  return errors;
}

function run() {
  const root = path.resolve(__dirname, '..');
  const snapshot = architectureSnapshot(root);
  const errors = architectureErrors(snapshot);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`architecture gate: ${error}\n`);
    for (const cycle of snapshot.cycles) {
      process.stderr.write(`${cycle.map((file) => path.relative(root, file)).join(' -> ')}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `architecture gate: PASS (production=${snapshot.productionFileCount}/${snapshot.productionEdgeCount}, ` +
    `test=${snapshot.testFileCount}/${snapshot.testEdgeCount}, ` +
    `support=${snapshot.supportFileCount}/${snapshot.supportEdgeCount}, ` +
    `all=${snapshot.fileCount}/${snapshot.edgeCount}, ` +
    `mainDeps=${snapshot.mainDirectDependencies}/${snapshot.mainTransitiveDependencies}` +
    `+${snapshot.mainCompositionBindings}=${snapshot.mainEffectiveDirectDependencies}, ` +
    `libFan=${snapshot.libMaxFanOut}/${snapshot.libMaxFanIn}, rootDebt=${snapshot.rootLibraryFileCount}, ` +
    `composition=${snapshot.runtimeCompositionExports}/${snapshot.runtimeCompositionMembers}, ` +
    `mainLines=${snapshot.mainLines}, ` +
    `rendererLines=${snapshot.rendererLines})\n`,
  );
}

if (require.main === module) run();

module.exports = {
  RENDERER_SHARED_SOURCES,
  BASELINE,
  architectureErrors,
  architectureSnapshot,
  buildDependencyGraph,
  collectJavaScriptFiles,
  domainDependencyErrors,
  destructuredBindingNames,
  dependencyLayerErrors,
  edgeCount,
  edgeCountForSources,
  filesInScope,
  findCycles,
  graphFanMetrics,
  loadRootLibraryDebt,
  moduleExportNames,
  namedFrozenObjectMemberNames,
  JAVASCRIPT_SCOPE,
  javascriptScope,
  relativeRequires,
  rootLibraryDebtErrors,
  rootLibraryFiles,
  transitiveDependencies,
  unresolvedRelativeRequireErrors,
};
