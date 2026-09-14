'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseScriptEntries, modulePaths } = require('../../../scripts/renderer-html-entrypoints');

test('HTML script inventory resolves canonical classic and module paths without reading comments', () => {
  assert.deepEqual(parseScriptEntries(`<!-- <script src="ignored.js"></script> -->
    <script src="../lib/shared.js"></script><script type='module' src='./app.js'></script>`, 'renderer/index.html'), [
    {page:'renderer/index.html',file:'lib/shared.js',module:false},
    {page:'renderer/index.html',file:'renderer/app.js',module:true},
  ]);
});
test('HTML script inventory rejects hidden or ambiguous executable entries', () => {
  for(const markup of [
    '<script>window.hidden={}</script>', '<script src="https://example.invalid/app.js"></script>',
    '<script src="app.js" src="other.js"></script>', '<script src=app.js></script>',
    '<script src="&#97;pp.js"></script>', '<script src="app.js?mode=other"></script>',
    '<script src="../../../escape.js"></script>', '<script src="app.js">hidden()</script>',
    '<script src="app.js"></script><script src="./app.js"></script>', '<script src="app.js">',
    '<script async src="app.js"></script>', '<script type="importmap">{}</script>',
    '<base href="https://example.invalid/"><script src="app.js"></script>',
    '<!-- unclosed <script src="app.js"></script>',
    '<script defer src="app.js"></script>', '<script defer="false" src="app.js"></script>',
    '<script defer="" src="app.js"></script>', '<script async="async" src="app.js"></script>',
    '<script type="module" defer="defer" src="app.js"></script>',
    '<script defer="defer" defer="defer" src="app.js"></script>',
  ]) assert.throws(()=>parseScriptEntries(markup,'renderer/index.html'),undefined,markup);
});

test('canonical deferred classic scripts preserve the inventory and module distinction', () => {
  assert.deepEqual(parseScriptEntries('<script defer="defer" src="app.js"></script>', 'renderer/index.html'),
    [{page:'renderer/index.html',file:'renderer/app.js',module:false}]);
});

test('one source cannot silently change classic/module meaning between pages', () => {
  assert.throws(()=>modulePaths([
    ...parseScriptEntries('<script src="shared.js"></script>','renderer/index.html'),
    ...parseScriptEntries('<script type="module" src="shared.js"></script>','renderer/second.html'),
  ]),/conflicting modes/u);
});
