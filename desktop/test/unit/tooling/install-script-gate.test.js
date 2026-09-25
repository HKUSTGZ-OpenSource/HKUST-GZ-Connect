'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  installScriptPackages,
  verifyInstallScriptAllowlist,
} = require('../../../scripts/check-install-scripts');

function lock(packages) {
  return { lockfileVersion: 3, packages };
}

test('install-script gate reports the exact lockfile package and version', () => {
  const document = lock({
    '': { name: 'desktop' },
    'node_modules/electron-winstaller': { version: '5.4.0', hasInstallScript: true },
    'node_modules/no-script': { version: '1.0.0' },
  });
  assert.deepEqual(installScriptPackages(document), ['electron-winstaller@5.4.0']);
  assert.deepEqual(verifyInstallScriptAllowlist(document), ['electron-winstaller@5.4.0']);
});

test('install-script gate rejects unexpected or malformed dependency scripts', () => {
  assert.throws(() => verifyInstallScriptAllowlist(lock({
    'node_modules/unreviewed': { version: '1.0.0', hasInstallScript: true },
  })), /unexpected dependency install scripts/u);
  assert.throws(() => installScriptPackages(null), /invalid schema/u);
  assert.throws(() => installScriptPackages(lock({
    'node_modules/no-version': { hasInstallScript: true },
  })), /version is invalid/u);
});
