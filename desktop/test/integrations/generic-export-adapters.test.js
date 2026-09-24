'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { customProfileDocument } = require('../../lib/profiles/onboarding/custom-gateway-onboarding');
const {
  buildClashCompatibleYaml,
  buildGenericExport,
  buildVscodeRemoteSshSnippet,
  clashRuleLines,
} = require('../../lib/integrations/generic-export-adapters');
const {
  createProfileNetworkRules,
} = require('../../lib/integrations/profile-network-rules');

const reviewed = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'assets', 'profiles', 'hkustgz', 'school-profile.json'), 'utf8'));
const material = Object.freeze({ username: 'A'.repeat(32), password: 'B'.repeat(32) });
const credential = {
  withStrings(callback) { return callback(material.username, material.password); },
};

test('shared Clash / Mihomo export has one Profile-bound node and precedence-ordered rules', () => {
  const rules = createProfileNetworkRules({
    profileDocument: reviewed,
    userRules: [
      { host: 'direct.example.edu', includeSubdomains: false, route: 'direct', updatedAt: 2 },
      { host: 'campus.example.edu', includeSubdomains: true, route: 'campus', updatedAt: 1 },
    ],
    serverResources: [{
      url: 'https://library.hkust-gz.edu.cn/', route: 'direct',
    }],
    campusCidrs: ['10.90.0.0/16'],
  });
  const lines = clashRuleLines(rules, 'Campus Connect - hkustgz');
  assert.equal(lines[0], 'DOMAIN,remote.hkust-gz.edu.cn,DIRECT');
  assert.ok(lines.indexOf('DOMAIN,direct.example.edu,DIRECT') <
    lines.indexOf('DOMAIN-SUFFIX,hkust-gz.edu.cn,Campus Connect - hkustgz'));
  assert.ok(lines.includes('DOMAIN-SUFFIX,campus.example.edu,Campus Connect - hkustgz'));
  assert.ok(lines.indexOf('DOMAIN,library.hkust-gz.edu.cn,DIRECT') <
    lines.indexOf('DOMAIN-SUFFIX,hkust-gz.edu.cn,Campus Connect - hkustgz'),
  'reviewed exact routes must precede the generic school suffix in first-match exports');
  assert.equal(lines.at(-1), 'IP-CIDR,10.90.0.0/16,Campus Connect - hkustgz,no-resolve');

  const adapterId = 'clash_mihomo_yaml';
  const yaml = buildClashCompatibleYaml({
    adapterId, port: 6180, credential, networkRules: rules,
  });
  assert.match(yaml, /^# Campus Connect Clash \/ Mihomo export$/mu);
  assert.match(yaml, /name: "Campus Connect - hkustgz"/u);
  assert.match(yaml, /server: "127\.0\.0\.1"/u);
  assert.match(yaml, /port: 6180/u);
  assert.match(yaml, new RegExp(`username: ${JSON.stringify(material.username)}`, 'u'));
  assert.match(yaml, new RegExp(`password: ${JSON.stringify(material.password)}`, 'u'));
  assert.match(yaml, /udp: false/u);
  assert.match(yaml, /rules:/u);
  assert.equal(require('../../lib/integrations/generic-export-adapters')
    .validateGenericExportPayload(adapterId, Buffer.from(yaml)), true);
});

test('custom Profile export never inherits HKUST names domains CIDRs or routes', () => {
  const profileDocument = customProfileDocument({
    profileId: `custom-${'c'.repeat(32)}`,
    origin: 'https://vpn.example.edu',
    schoolLabel: 'Example University',
  });
  const rules = createProfileNetworkRules({ profileDocument });
  const yaml = buildClashCompatibleYaml({
    adapterId: 'clash_mihomo_yaml', port: 6180, credential, networkRules: rules,
  });
  assert.match(yaml, new RegExp(`Campus Connect - ${profileDocument.profileId}`, 'u'));
  assert.doesNotMatch(yaml, /hkust|10\.90\./iu);
  assert.match(yaml, /DOMAIN,vpn\.example\.edu,DIRECT/u);
});

test('VS Code export is a copy-only ProxyCommand snippet without embedded credentials', () => {
  const rules = createProfileNetworkRules({ profileDocument: reviewed });
  const helperPath = path.resolve('synthetic tools', process.platform === 'win32' ? 'ec-proxy-command.exe' : 'ec-proxy-command');
  const credentialFile = path.resolve('synthetic private data', 'proxy-credential');
  const snippet = buildVscodeRemoteSshSnippet({
    helperPath, credentialFile,
    networkRules: rules,
  });
  assert.match(snippet, /^Host campus-connect-server$/mu);
  assert.match(snippet, /ProxyCommand .*--profile-id "hkustgz"/u);
  assert.doesNotMatch(snippet, new RegExp(material.password, 'u'));
  assert.equal(require('../../lib/integrations/generic-export-adapters')
    .validateGenericExportPayload('vscode_remote_ssh', Buffer.from(snippet)), true);
  const generated = buildGenericExport({
    adapterId: 'vscode_remote_ssh',
    networkRules: rules,
    helperPath, credentialFile,
  });
  assert.equal(generated.containsLocalProxyCredential, false);
  assert.equal(generated.warningCode, 'INTEGRATION_CREDENTIAL_SIDECAR_PRIVATE');
  generated.payload.fill(0);
  assert.throws(() => buildGenericExport({
    adapterId: 'pac', networkRules: rules,
  }), /unsupported/u);
});
