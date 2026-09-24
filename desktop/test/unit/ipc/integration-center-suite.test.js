'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  createIntegrationTargetSelector,
  selectedIntegrationTargetFile,
} = require('../../../lib/ipc/integration-center-suite');

test('target selector writes only one user-selected Clash / Mihomo export file', async () => {
  const calls = [];
  // Path-only fixture: no real home directory or user file is accessed.
  const homeDirectory = path.resolve('synthetic-export-home');
  const selectedFile = path.join(homeDirectory, 'campus.yaml');
  const results = [
    { canceled: false, filePath: selectedFile },
  ];
  const dialog = {
    showSaveDialog: async (...args) => { calls.push(['save', args]); return results.shift(); },
  };
  const select = createIntegrationTargetSelector({
    dialog, getParentWindow: () => null, homeDirectory,
  });
  assert.equal(await select({ adapterId: 'clash_mihomo_yaml', action: 'save' }),
    selectedFile);
  assert.equal(await select({ adapterId: 'mihomo_yaml', action: 'save' }), null);
  assert.equal(await select({ adapterId: 'openssh_proxy_command', action: 'install' }), null);
  assert.equal(await select({ adapterId: 'clash_verge_rev_managed', action: 'install' }), null);
  assert.equal(calls[0][1].length, 1, 'dialog without a live parent gets options only');
  assert.equal(calls.length, 1, 'unsupported adapters must not open another dialog');
  assert.equal(calls[0][1][0].defaultPath, path.join(homeDirectory, 'campus-connect-clash-mihomo.yaml'));
  assert.equal(path.isAbsolute(calls[0][1][0].defaultPath), true);
  assert.equal(path.dirname(calls[0][1][0].defaultPath), homeDirectory);
  assert.equal(calls.every(([method]) => method === 'save'), true);
  assert.equal(selectedIntegrationTargetFile({ canceled: false, filePaths: ['/one', '/two'] }), null);
  assert.equal(selectedIntegrationTargetFile({ canceled: true, filePath: selectedFile }), null);
});
