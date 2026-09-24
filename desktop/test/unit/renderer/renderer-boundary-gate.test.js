'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeRendererSource } = require('../../../scripts/renderer-source-analysis');
const { rendererBoundaryErrors, validateRegistry, checkRendererBoundaries } = require('../../../scripts/renderer-boundaries');
const { collectJavaScriptFiles, RENDERER_SHARED_SOURCES, architectureErrors } = require('../../../scripts/check-architecture');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const analyze = source => analyzeRendererSource(source, { module: true });
const { collectRendererScriptEntries } = require('../../../scripts/renderer-html-entrypoints');

test('AST analysis ignores comments and strings but follows direct and literal-key global aliases', () => {
  const result = analyze(`
    // window.comment = 1;
    const text = 'globalThis.string = 1';
    const target = window;
    const key = 'computed';
    target.direct = 1;
    self['literal'] = 1;
    globalThis[key] = 1;
  `);
  assert.deepEqual(result.exports, ['computed', 'direct', 'literal']);
  assert.deepEqual(result.errors, []);
});

test('UMD factory parameters and returned aliases retain global provenance', () => {
  const result = analyze(`
    (function(root, factory) { root.publicApi = factory(root); })(
      typeof self !== 'undefined' ? self : globalThis,
      function(target) { target.factoryAlias = {}; return {}; });
    function getTarget() { return window; }
    const alias = getTarget();
    alias.returnedAlias = {};
    const publish = ({ target }) => { target.destructured = {}; };
    publish({ target: window });
  `);
  assert.deepEqual(result.exports, ['destructured', 'factoryAlias', 'publicApi', 'returnedAlias']);
});

test('lexical shadowing of browser names and local DOM roots is not a global export', () => {
  const result = analyze(`
    function helper(window) { window.local = 1; }
    const target = window;
    { const target = {}; target.local = 1; }
    try {} catch (window) { window.message = 'local'; }
    for (const window of []) { window.local = 1; }
    target.actual = 1;
  `);
  assert.deepEqual(result.exports, ['actual']);
});

test('reflective writers and their aliases cannot add globals invisibly', () => {
  const result = analyze(`
    const define = Object.defineProperty;
    define(window, 'defined', { value: {} });
    const { assign } = Object;
    assign(globalThis, { assigned: {}, ['literal']: {} });
    Reflect.set(self, 'reflected', {});
  `);
  assert.deepEqual(result.exports, ['assigned', 'defined', 'literal', 'reflected']);
  assert.ok(analyze('window[unknown] = {};').errors.length);
  assert.ok(analyze('Object.assign(window, unknown);').errors.length);
  assert.ok(analyze('Object.assign(window, { ...unknown });').errors.length);
});

test('destructuring assignments and loop targets cannot publish hidden globals', () => {
  const result = analyze(`
    ({ value: window.objectTarget } = incoming);
    [globalThis.arrayTarget] = incoming;
    for (self.loopTarget of incoming) {}
  `);
  assert.deepEqual(result.exports, ['arrayTarget', 'loopTarget', 'objectTarget']);
});

test('classic top-level bindings are tracked while module bindings stay private', () => {
  assert.deepEqual(analyzeRendererSource('const privateState = {}; function helper() {}').exports,
    ['@binding:helper', '@binding:privateState']);
  assert.deepEqual(analyze('const privateState = {}; function helper() {}').exports, []);
});

test('classic global this survives blocks and lexical arrows without capturing local method this', () => {
  assert.deepEqual(analyzeRendererSource('{ this.blockExport = {}; (() => { this.arrowExport = {}; })(); }').exports,
    ['arrowExport','blockExport']);
  assert.deepEqual(analyzeRendererSource('({ method() { this.localField = {}; } });').exports, []);
  assert.deepEqual(analyze('(() => { this.notWindow = {}; })();').exports, []);
});

test('new classic scripts cannot add hidden HTML-order coupling without global assignments', () => {
  const f = fixture();
  const records = new Map(Object.entries(f.sources).map(([file, source]) => [file, analyze(source)]));
  records.set('renderer/new-classic.js', analyzeRendererSource('(() => {})();'));
  assert.ok(rendererBoundaryErrors(f.registry, records).some(error => error.includes('unregistered classic')));
});

test('module paths and public exports come from syntax, not strings or comments', () => {
  const result = analyze(`
    import { create } from './controller.mjs';
    export { create };
    export { weekRange } from './model.mjs';
    const load = () => import('./optional.mjs');
    // import('./comment.mjs');
    const text = "require('./string.js')";
    function local(require) { require('./not-a-module.js'); }
  `);
  assert.deepEqual(result.imports, ['./controller.mjs', './model.mjs', './optional.mjs']);
  assert.deepEqual(result.moduleExports, ['create', 'weekRange']);
  assert.ok(analyze('import(destination);').errors.length);
  assert.ok(analyze('export * from "./model.mjs";').errors.length);
  assert.throws(() => analyze('export const ='), SyntaxError);
});

test('cyclic local object models terminate and accessor aliases retain global provenance', () => {
  const result = analyze(`
    const recursive = () => ({ next: recursive() });
    recursive().next;
    const box = { get target() { return window; } };
    box.target.viaGetter = {};
    const literal = { ['target']: window };
    literal.target.viaObject = {};
  `);
  assert.deepEqual(result.exports, ['viaGetter', 'viaObject']);
  assert.deepEqual(result.errors, []);
});

test('opaque global escape and dynamic code execution are rejected', () => {
  for (const source of ['external(window);', 'Object.setPrototypeOf(window, {});',
    'eval("code");', 'const run = window.eval; run("code");', 'new Function("code");']) {
    assert.ok(analyze(source).errors.length, source);
  }
});

function fixture() {
  const sources = {
    'renderer/app.js': "import { create } from './features/a/index.mjs';",
    'renderer/legacy.js': 'window.legacy = {};',
    'renderer/features/a/index.mjs': "export { create } from './controller.mjs';",
    'renderer/features/a/controller.mjs': 'export function create() {}',
    'renderer/features/b/index.mjs': 'export function create() {}',
  };
  const registry = { schemaVersion: 1, bootstraps: ['renderer/app.js'], legacyGlobals: { 'renderer/legacy.js': ['legacy'] },
    features: ['a', 'b'].map(id => ({ id, root: `renderer/features/${id}`,
      entrypoint: `renderer/features/${id}/index.mjs`, exports: ['create'], allowedDependencies: [] })) };
  return { sources, registry, errors: () => rendererBoundaryErrors(registry,
    new Map(Object.entries(sources).map(([file, source]) => [file, analyze(source)]))) };
}

test('registry rejects new globals and requires retirement of obsolete exceptions', () => {
  const f = fixture();
  assert.deepEqual(f.errors(), []);
  f.sources['renderer/legacy.js'] += 'window.newFeature = {};';
  assert.ok(f.errors().some(error => error.includes('unapproved Renderer global')));
  f.sources['renderer/legacy.js'] = '';
  assert.ok(f.errors().some(error => error.includes('remove retired global exception')));
  delete f.sources['renderer/legacy.js'];
  assert.ok(f.errors().some(error => error.includes('stale legacy global owner')));
});

test('ownership schema rejects overlap, missing entrypoints, unowned files and API drift', () => {
  const f = fixture();
  f.registry.features[1].root = f.registry.features[0].root;
  assert.throws(() => validateRegistry(f.registry), /ownership/u);
  f.registry.features[1].root = 'renderer/features/b';
  f.registry.features[0].exports.push('unexpected');
  assert.ok(f.errors().some(error => error.includes('public exports changed')));
  delete f.sources['renderer/features/a/index.mjs'];
  assert.ok(f.errors().some(error => error.includes('missing feature entrypoint')));
  f.sources['renderer/features/unowned/index.mjs'] = 'export const value = 1;';
  assert.ok(f.errors().some(error => error.includes('unowned Renderer feature')));
  const extraField = { ...fixture().registry, bypass: true };
  assert.throws(() => validateRegistry(extraField), /schema/u);
});

test('cross-feature imports must use allowed public entrypoints', () => {
  const f = fixture();
  f.sources['renderer/app.js'] = "import { create } from './features/a/controller.mjs';";
  assert.ok(f.errors().some(error => error.includes('private Renderer import')));
  f.sources['renderer/app.js'] = "import { create } from './features/a/index.mjs';";
  f.sources['renderer/features/a/controller.mjs'] += "import '../b/index.mjs';";
  assert.ok(f.errors().some(error => error.includes('disallowed Renderer dependency')));
  f.registry.features[0].allowedDependencies.push('b');
  assert.deepEqual(f.errors(), []);
  f.sources['renderer/features/a/controller.mjs'] += "import 'node:fs';";
  assert.ok(f.errors().some(error => error.includes('non-local Renderer import')));
});

test('migrated modules cannot regain globals and constant dynamic imports remain checked', () => {
  const f = fixture();
  f.sources['renderer/features/a/controller.mjs'] += 'const leaked = window.document;';
  assert.ok(f.errors().some(error => error.includes('migrated feature uses browser globals')));
  f.sources['renderer/features/a/controller.mjs'] = 'export function create() {}';
  f.sources['renderer/app.js'] = "const target = './features/a/controller.mjs'; import(target);";
  assert.ok(f.errors().some(error => error.includes('private Renderer import')));
});

test('native modules outside registered features cannot bypass ownership', () => {
  const f = fixture();
  f.sources['renderer/unregistered.mjs'] = 'export function create() {}';
  f.sources['renderer/app.js'] = "import { create } from './unregistered.mjs';";
  assert.ok(f.errors().some(error => error.includes('unowned Renderer source')));
});

test('bootstrap ownership is explicit, disjoint and tied to an existing module', () => {
  const f = fixture();
  f.registry.bootstraps.push('renderer/legacy.js');
  assert.throws(() => validateRegistry(f.registry), /bootstrap ownership/u);
  f.registry.bootstraps.pop();
  delete f.sources['renderer/app.js'];
  assert.ok(f.errors().some(error => error.includes('missing Renderer bootstrap')));
});

test('HTML module tags cannot bypass the explicit bootstrap with a feature-private entrypoint', () => {
  const f=fixture();
  const records=new Map(Object.entries(f.sources).map(([file,source])=>[file,analyze(source)]));
  const privateFile='renderer/features/a/controller.mjs';
  records.set(privateFile,{...records.get(privateFile),htmlModule:true});
  assert.ok(rendererBoundaryErrors(f.registry,records).some(error=>error.includes('HTML module entrypoint')));
});

test('AST-resolved import cycles are rejected even when dependencies are allowed', () => {
  const f = fixture();
  f.registry.features[0].allowedDependencies.push('b');
  f.registry.features[1].allowedDependencies.push('a');
  f.sources['renderer/features/a/index.mjs'] = "export { create } from '../b/index.mjs';";
  f.sources['renderer/features/b/index.mjs'] = "export { create } from '../a/index.mjs';";
  assert.ok(f.errors().some(error => error.includes('Renderer import cycle')));
});

test('current Renderer matches the frozen registry and public-entrypoint policy', () => {
  const root = path.resolve(__dirname, '../../..');
  assert.deepEqual(checkRendererBoundaries(root, collectJavaScriptFiles(root), RENDERER_SHARED_SOURCES), []);
});

test('existing architecture gate propagates Renderer boundary failures', () => {
  assert.deepEqual(architectureErrors({ cycles: [], rendererBoundaryErrors: ['blocked Renderer edge'] }),
    ['blocked Renderer edge']);
});

test('nested composition roots are explicit and cannot take over a feature-owned file', () => {
  const f = fixture();
  f.registry.bootstraps.push('renderer/features/index.mjs', 'renderer/bootstrap/registry.mjs');
  f.sources['renderer/features/index.mjs'] = "export {create} from './a/index.mjs';";
  f.sources['renderer/bootstrap/registry.mjs'] = 'export function mount() {}';
  assert.deepEqual(f.errors(), []);
  f.sources['renderer/bootstrap/unowned.mjs'] = 'export function mount() {}';
  assert.ok(f.errors().some(error => error.includes('unowned Renderer source')));
  f.registry.bootstraps.push('renderer/features/a/controller.mjs');
  assert.throws(() => validateRegistry(f.registry), /bootstrap ownership/u);
});

test('mutable member escapes are rejected and migrated DOM/network globals require injection', () => {
  assert.ok(analyze('const box={}; box.target=window; box.target.hiddenExport={};').errors.length);
  const f=fixture();
  for(const source of ['document.title;', 'fetch("https://example.edu");', 'localStorage.getItem("x");']) {
    f.sources['renderer/features/a/controller.mjs']=source;
    assert.ok(f.errors().some(error=>error.includes('uses browser globals')),source);
  }
  f.sources['renderer/features/a/controller.mjs']='export function create({document,fetch}) { document.title; fetch(); }';
  assert.deepEqual(f.errors(), []);
});

test('static feature ownership includes the bounded host and native entrypoints without retired globals', () => {
  const registry=require('../../../scripts/renderer-feature-registry.json');
  assert.deepEqual(registry.features.map(({id})=>id).sort(),['campus-data','feature-host','official-favorites']);
  assert.deepEqual(registry.features.find(({id})=>id==='feature-host').allowedDependencies,['campus-data','official-favorites']);
  for (const feature of registry.features) {
    assert.deepEqual(Object.keys(require(path.resolve(__dirname,'../../..',feature.entrypoint))).sort(),
      [...feature.exports].sort());
  }
  assert.equal(Object.hasOwn(registry.legacyGlobals,'renderer/campus-data-modules.js'),false);
  assert.equal(Object.hasOwn(registry.legacyGlobals,'renderer/official-favorite-dialog.js'),false);
});

test('real architecture CLI fails on globals, private imports, HTML bypass and public API drift in an isolated copy', () => {
  const desktop=path.resolve(__dirname,'../../..');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hkustgz-boundary-cli-'));
  const fixtureRoot=path.join(root,'desktop');
  try {
    for(const source of [...collectJavaScriptFiles(desktop),
      ...[...new Set(collectRendererScriptEntries(desktop).map(entry=>entry.page)),
        'scripts/architecture-root-debt.json','scripts/renderer-feature-registry.json'].map(file=>path.join(desktop,file))]) {
      const target=path.join(fixtureRoot,path.relative(desktop,source));
      fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(source,target);
    }
    const run=()=>spawnSync(process.execPath,[path.join(fixtureRoot,'scripts/check-architecture.js')],{
      encoding:'utf8',timeout:15000,env:{...process.env,NODE_PATH:
        [path.join(desktop,'node_modules'),process.env.NODE_PATH].filter(Boolean).join(path.delimiter)},
    });
    const clean=run(); assert.equal(clean.status,0,clean.stderr);
    const file=path.join(fixtureRoot,'renderer/app.js'), original=fs.readFileSync(file,'utf8');
    fs.appendFileSync(file,'\nwindow.unapprovedProbe = {};\n');
    const globalFailure=run(); assert.equal(globalFailure.status,1);
    assert.match(globalFailure.stderr,/unapproved Renderer global.*unapprovedProbe/u);
    fs.writeFileSync(file,original+"\nimport './features/campus-data/controller.mjs';\n");
    const privateFailure=run(); assert.equal(privateFailure.status,1);
    assert.match(privateFailure.stderr,/private Renderer import/u);
    fs.writeFileSync(file,original);
    const htmlFile=path.join(fixtureRoot,'renderer/index.html'), html=fs.readFileSync(htmlFile,'utf8');
    fs.writeFileSync(htmlFile,html.replace('</body>', '<script type="module" src="features/campus-data/controller.mjs"></script></body>'));
    const htmlFailure=run(); assert.equal(htmlFailure.status,1);
    assert.match(htmlFailure.stderr,/unapproved HTML module entrypoint/u);
    fs.writeFileSync(htmlFile,html);
    const browserPage=path.join(fixtureRoot,'renderer/campus-browser.html');
    const browserHtml=fs.readFileSync(browserPage,'utf8');
    fs.writeFileSync(browserPage,browserHtml.replace('</body>',
      '<script src="../lib/browser/session/browser-session-manager.js"></script></body>'));
    const classicFailure=run(); assert.equal(classicFailure.status,1);
    assert.match(classicFailure.stderr,/unapproved HTML script entrypoint.*campus-browser/u);
    fs.writeFileSync(browserPage,browserHtml);
    const nestedPage=path.join(fixtureRoot,'renderer/extra/nested.html');
    fs.mkdirSync(path.dirname(nestedPage),{recursive:true});
    fs.writeFileSync(nestedPage,'<script type="module" src="../features/campus-data/controller.mjs"></script>');
    const nestedFailure=run(); assert.equal(nestedFailure.status,1);
    assert.match(nestedFailure.stderr,/unapproved HTML script entrypoint.*nested.html/u);
    fs.unlinkSync(nestedPage);
    const entry=path.join(fixtureRoot,'renderer/features/official-favorites/index.mjs');
    fs.appendFileSync(entry,'\nexport const accidentalPublicApi = true;\n');
    const apiFailure=run(); assert.equal(apiFailure.status,1);
    assert.match(apiFailure.stderr,/feature public exports changed/u);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
