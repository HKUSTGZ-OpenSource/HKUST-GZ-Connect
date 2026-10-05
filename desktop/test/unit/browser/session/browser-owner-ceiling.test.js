'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

test('all named Browser owner classes, including the runtime root, stay within the M2 ceiling', () => {
  const root = path.resolve(__dirname, '../../../../lib/browser');
  const classes = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && filename.endsWith('.js')) {
        const source = fs.readFileSync(filename, 'utf8');
        const tree = acorn.parse(source, { ecmaVersion: 'latest', locations: true });
        function inspect(node) {
          if (!node || typeof node !== 'object') return;
          if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
            const name = node.id?.name || `${path.relative(root, filename)}:${node.loc.start.line}`;
            const lines = node.loc.end.line - node.loc.start.line + 1;
            classes.push(name);
            assert.ok(lines <= 600, `${name}: ${lines} lines exceeds the M2 owner ceiling`);
          }
          for (const [key, value] of Object.entries(node)) {
            if (['loc', 'start', 'end'].includes(key)) continue;
            if (Array.isArray(value)) value.forEach(inspect);
            else if (value && typeof value === 'object') inspect(value);
          }
        }
        inspect(tree);
      }
    }
  }
  visit(root);
  for (const required of ['CampusBrowser', 'CampusBrowserManager', 'CampusBrowserWindowOwner',
    'BrowserTabLifecycle', 'BrowserSessionManager', 'CredentialController', 'ManagedCredentialPopupOwner',
    'BrowserOpenOwner', 'BrowserTabCreationOwner', 'BrowserLocalePresentationOwner']) assert.ok(classes.includes(required), required);
});
