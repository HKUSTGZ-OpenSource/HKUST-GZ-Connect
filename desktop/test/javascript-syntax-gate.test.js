'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  controlModuleEntrypoints,
  checkJavaScriptSource,
  checkJavaScriptTree,
  listJavaScriptFiles,
  parseArguments,
  safeTrackedPath,
} = require('../scripts/check-javascript-syntax');

test('HTML module declarations select module parsing independently of the js extension', () => {
  assert.deepEqual([...controlModuleEntrypoints(`
    <!-- <script type="module" src="ignored.js"></script> -->
    <script src="classic.js"></script>
    <script type="module" src="app.js"></script>
    <script src='auth-challenge.js' type='module'></script>
  `)], ['desktop/renderer/app.js', 'desktop/renderer/auth-challenge.js']);
  for (const source of ['https://example.invalid/app.js', '../../escape.js', '/absolute.js']) {
    assert.throws(() => controlModuleEntrypoints(`<script type="module" src="${source}"></script>`));
  }
});

test('syntax gate argument and tracked-path schemas are exact', () => {
  assert.deepEqual(parseArguments([]), { tree: 'HEAD' });
  assert.deepEqual(parseArguments(['--tree', 'abc123']), { tree: 'abc123' });
  assert.throws(() => parseArguments(['--unknown']), /usage/u);
  assert.throws(() => parseArguments(['--tree', '--bad']), /invalid/u);
  assert.equal(safeTrackedPath('desktop/lib/example.js'), 'desktop/lib/example.js');
  assert.equal(safeTrackedPath('desktop/renderer/model.mjs'), 'desktop/renderer/model.mjs');
  for (const value of ['/absolute.js', '../escape.js', 'x/../escape.js', 'x\\bad.js',
    'x:bad.js', 'x\nbad.js']) {
    assert.throws(() => safeTrackedPath(value), /invalid/u);
  }
});

test('syntax gate fails closed on an empty or malformed Git enumeration', () => {
  const execute = () => ({ status: 0, stdout: Buffer.alloc(0) });
  assert.throws(() => listJavaScriptFiles({ repoRoot: '/repo', tree: 'HEAD', execute }),
    /zero JavaScript/u);
  assert.throws(() => listJavaScriptFiles({
    repoRoot: '/repo', tree: 'HEAD',
    execute: () => ({ status: 1, stdout: Buffer.alloc(0) }),
  }), /could not enumerate/u);
});

test('syntax gate excludes generated dependency/output trees and retains exact tracked sources', () => {
  const stdout = Buffer.from([
    'desktop/main.js',
    'desktop/renderer/model.mjs',
    'desktop/lib/space name.js',
    'desktop/node_modules/ignored.js',
    'desktop/release/ignored.js',
    '',
  ].join('\0'));
  const files = listJavaScriptFiles({
    repoRoot: '/repo', tree: 'HEAD',
    execute: () => ({ status: 0, stdout }),
  });
  assert.deepEqual(files, ['desktop/lib/space name.js', 'desktop/main.js', 'desktop/renderer/model.mjs']);
});

test('syntax gate invokes the real Node parser and rejects invalid JavaScript', () => {
  assert.equal(checkJavaScriptSource(Buffer.from("'use strict';\nconst answer = 42;\n")).ok, true);
  assert.equal(checkJavaScriptSource(Buffer.alloc(0)).ok, true);
  const invalid = checkJavaScriptSource(Buffer.from("'use strict';\nconst answer =\n"));
  assert.equal(invalid.ok, false);
  assert.match(invalid.diagnostic, /SyntaxError/u);
  assert.equal(checkJavaScriptSource(Buffer.from('export const answer = 42;'), { module: true }).ok, true);
  assert.equal(checkJavaScriptSource(Buffer.from('return 42;'), { module: true }).ok, false);
});

test('exact-tree syntax parsing uses module declarations from secondary HTML pages too', () => {
  const sources={
    'desktop/main.js':'const main = true;',
    'desktop/renderer/secondary.js':'export const secondary = true;',
    'desktop/renderer/index.html':'<main></main>',
    'desktop/renderer/secondary.html':'<script type="module" src="secondary.js"></script>',
  };
  let secondaryParsed=false;
  const execute=(command,args,options)=>{
    if(command==='git' && args[0]==='ls-tree') return {status:0,stdout:Buffer.from(Object.keys(sources).join('\0')+'\0')};
    if(command==='git' && args[0]==='show') return {status:0,stdout:Buffer.from(sources[args[1].slice('HEAD:'.length)])};
    if(command===process.execPath) {
      if(options.input.toString().startsWith('export')) {
        assert.ok(args.includes('--input-type=module')); secondaryParsed=true;
      }
      return {status:0,stderr:''};
    }
    throw new Error('unexpected syntax command');
  };
  assert.deepEqual(checkJavaScriptTree({repoRoot:'/fixture',tree:'HEAD',execute}).failures,[]);
  assert.equal(secondaryParsed,true);
});
