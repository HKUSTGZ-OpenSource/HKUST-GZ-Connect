'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyMacSignature,
  parseCodeSigningIdentities,
  selectLocalAppleIdentity,
  shouldDelegateSigning,
} = require('../../../build/macos-signing');

test('local signing prefers Developer ID over Apple Development', () => {
  const identities = parseCodeSigningIdentities(
    '  1) A1B2C3D4E5F6 "Apple Development: Example (TEAM)"\n'
    + '  2) F1E2D3C4B5A6 "Developer ID Application: Example (TEAM)"\n',
  );

  assert.deepEqual(selectLocalAppleIdentity(identities), {
    hash: 'F1E2D3C4B5A6',
    name: 'Developer ID Application: Example (TEAM)',
    kind: 'developer-id',
  });
});

test('local signing ignores unsupported identities and falls back predictably', () => {
  const identities = parseCodeSigningIdentities(
    '  1) A1B2C3D4E5F6 "Mac Developer: Legacy (TEAM)"\n'
    + '  2) B1C2D3E4F5A6 "Apple Development: Example (TEAM)"\n',
  );

  assert.deepEqual(selectLocalAppleIdentity(identities), {
    hash: 'B1C2D3E4F5A6',
    name: 'Apple Development: Example (TEAM)',
    kind: 'apple-development',
  });
  assert.equal(selectLocalAppleIdentity([]), null);
});

test('release signing remains under electron-builder control', () => {
  assert.equal(shouldDelegateSigning({ CSC_LINK: 'base64-cert' }), true);
  assert.equal(shouldDelegateSigning({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' }), true);
  assert.equal(shouldDelegateSigning({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }), false);
  assert.equal(shouldDelegateSigning({}), false);
});

test('signature classification distinguishes Apple and ad-hoc signing', () => {
  assert.equal(
    classifyMacSignature('Signature=adhoc\nTeamIdentifier=not set'),
    'adhoc',
  );
  assert.equal(
    classifyMacSignature('Authority=Apple Development\nTeamIdentifier=TEAM123'),
    'apple',
  );
  assert.equal(classifyMacSignature('Authority=Unknown'), 'unknown');
});
