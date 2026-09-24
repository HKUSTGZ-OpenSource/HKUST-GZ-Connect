'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCustomEngineConfigDocument,
  serializeCustomEngineConfig,
  verifyCustomEngineConfigFile,
} = require('../../../../lib/profiles/provisioning/custom-engine-config');
const { customProfileDocument } = require('../../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { protectWindowsFileOwnerOnly, verifyWindowsFileOwnerOnly } = require('../../../../lib/platform/storage/windows-private-file');

function profile(origin = 'https://vpn.example.edu') {
  return customProfileDocument({
    profileId: `custom-${'1'.repeat(32)}`,
    origin,
    schoolLabel: 'Example University',
  });
}

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-engine-config-'));
  fs.chmodSync(value, 0o700);
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test('custom Engine config varies only by confirmed origin and has no reviewed school policy', () => {
  const first = createCustomEngineConfigDocument(profile());
  const second = createCustomEngineConfigDocument(profile('https://other.example.edu:444'));
  assert.equal(first.base_url, 'https://vpn.example.edu');
  assert.equal(second.base_url, 'https://other.example.edu:444');
  assert.deepEqual({ ...first, base_url: second.base_url }, second);
  assert.deepEqual(first.proxy.vpn_dns_servers, []);
  assert.equal(first.proxy.allow_system_dns_fallback, false);
  assert.equal(first.gateway_connector.reviewed_private_gateway_allowed, false);
  assert.deepEqual(Object.keys(first.endpoints).sort(), [
    'discovery', 'logout', 'password_config', 'password_login', 'resource_list', 'session_config',
  ]);
  const encoded = JSON.stringify(first);
  for (const forbidden of ['10.90.63.2', 'hkust', 'packages', 'windows_installer', 'ca_file']) {
    assert.equal(encoded.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('owner-only config is re-read and hash-bound before Engine launch', (t) => {
  const root = directory(t);
  const file = path.join(root, 'engine-config.json');
  const source = profile();
  fs.writeFileSync(file, serializeCustomEngineConfig(source), { mode: 0o600 });
  if (process.platform === 'win32') {
    assert.equal(protectWindowsFileOwnerOnly(file), true);
    assert.equal(verifyWindowsFileOwnerOnly(file), true);
  }
  const verified = verifyCustomEngineConfigFile({ filePath: file, profile: source });
  assert.equal(verified.gatewayOrigin, 'https://vpn.example.edu');
  assert.match(verified.sha256, /^[a-f0-9]{64}$/u);

  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.endpoints.password_login = '/attacker-controlled';
  fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  assert.throws(() => verifyCustomEngineConfigFile({ filePath: file, profile: source }),
    /compiled Profile binding/u);
});

test('custom Engine config rejects links broad permissions and reviewed Profiles', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = directory(t);
  const source = profile();
  const file = path.join(root, 'engine-config.json');
  fs.writeFileSync(file, serializeCustomEngineConfig(source), { mode: 0o644 });
  assert.throws(() => verifyCustomEngineConfigFile({ filePath: file, profile: source }),
    /private file/u);
  fs.unlinkSync(file);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, serializeCustomEngineConfig(source), { mode: 0o600 });
  fs.symlinkSync(outside, file);
  assert.throws(() => verifyCustomEngineConfigFile({ filePath: file, profile: source }),
    /private file/u);

  const reviewed = JSON.parse(JSON.stringify(source));
  reviewed.evidenceClass = 'builtin-reviewed';
  assert.throws(() => createCustomEngineConfigDocument(reviewed));
});
