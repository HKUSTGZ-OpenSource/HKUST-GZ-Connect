'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const yaml = require('js-yaml');
const { customProfileDocument } = require('../../../lib/profiles/onboarding/custom-gateway-onboarding');
const { createProfileNetworkRules } = require('../../../lib/integrations/profile-network-rules');
const { buildGenericExport, validateGenericExportPayload } = require('../../../lib/integrations/generic-export-adapters');

const networkRules = createProfileNetworkRules({
  profileDocument: customProfileDocument({ profileId: `custom-${'c'.repeat(32)}`,
    origin: 'https://vpn.example.edu', schoolLabel: 'Example University' }),
  userRules: [{ host: 'direct.example.edu', includeSubdomains: false, route: 'direct', updatedAt: 1 }],
});
const input = { adapterId: 'clash_mihomo_yaml', port: 6180, networkRules,
  credential: { withStrings: fn => fn('A'.repeat(32), 'B'.repeat(32)) } };

test('explicit gateway-default forwards unmatched domains without website-specific rules', () => {
  const exported = buildGenericExport({ ...input, routingMode: 'gateway-default' });
  try {
    const parsed = yaml.load(exported.payload.toString());
    assert.equal(parsed['mixed-port'], 7890);
    assert.equal(parsed['allow-lan'], false);
    assert.equal(parsed['bind-address'], '127.0.0.1');
    assert.equal(parsed.mode, 'rule');
    assert.equal(parsed.rules.at(-1), `MATCH,${parsed.proxies[0].name}`);
    assert.equal(parsed.rules[0], 'DOMAIN,vpn.example.edu,DIRECT');
    assert.ok(parsed.rules.includes('DOMAIN,direct.example.edu,DIRECT'));
    assert.equal(parsed.proxies[0].udp, false);
    assert.equal(parsed.rules.at(-2), 'NETWORK,udp,REJECT', 'unmatched UDP must not silently escape the TCP gateway');
    assert.equal(parsed['proxy-groups'], undefined, 'no invented internet proxy group');
    assert.equal(parsed.dns, undefined, 'no invented gateway DNS or host DNS changes');
    assert.equal(validateGenericExportPayload(input.adapterId, exported.payload), true);
    assert.equal(exported.ruleCount, parsed.rules.length);
    assert.equal(exported.routingMode, 'gateway-default');
  } finally { exported.payload.fill(0); }
});

test('legacy YAML remains accepted without a routing-mode header', () => {
  const exported = buildGenericExport(input);
  const legacy = Buffer.from(exported.payload.toString().replace('# Routing: rules-only\n', ''));
  try { assert.equal(validateGenericExportPayload(input.adapterId, legacy), true); }
  finally { exported.payload.fill(0); legacy.fill(0); }
});

test('standalone inbound never collides with its upstream SOCKS port', () => {
  for (const proxyPort of [6180, 7890, 7891, 65535]) {
    const exported = buildGenericExport({ ...input, port: proxyPort, routingMode: 'gateway-default' });
    let collision;
    try {
      const parsed = yaml.load(exported.payload.toString());
      assert.equal(parsed.proxies[0].port, proxyPort);
      assert.equal(parsed['mixed-port'], proxyPort === 7890 ? 7891 : 7890);
      assert.notEqual(parsed['mixed-port'], parsed.proxies[0].port);
      assert.equal(validateGenericExportPayload(input.adapterId, exported.payload), true);
      collision = Buffer.from(exported.payload.toString().replace(
        `mixed-port: ${parsed['mixed-port']}`, `mixed-port: ${proxyPort}`));
      assert.equal(validateGenericExportPayload(input.adapterId, collision), false);
    } finally { exported.payload.fill(0); collision?.fill(0); }
  }
});

test('old requests retain rules-only output and cannot silently delegate internet traffic', () => {
  const exported = buildGenericExport(input);
  try {
    const parsed = yaml.load(exported.payload.toString());
    assert.equal(parsed.rules.some(rule => rule.startsWith('MATCH,')), false);
    assert.equal(exported.routingMode, 'rules-only');
  } finally { exported.payload.fill(0); }
});

test('IPv4 and IPv6 gateway origins bypass the tunnel as addresses, not domain rules', () => {
  for (const [origin, expected] of [
    ['https://203.0.113.20:4433', 'IP-CIDR,203.0.113.20/32,DIRECT,no-resolve'],
    ['https://[2001:db8::20]:4433', 'IP-CIDR6,2001:db8::20/128,DIRECT,no-resolve'],
  ]) {
    const profile = structuredClone(require('../../../assets/profiles/hkustgz/school-profile.json'));
    profile.gateway.origin = origin;
    const exported = buildGenericExport({ ...input, routingMode: 'gateway-default',
      networkRules: createProfileNetworkRules({ profileDocument: profile }) });
    try {
      assert.equal(yaml.load(exported.payload.toString()).rules[0], expected);
      assert.equal(validateGenericExportPayload(input.adapterId, exported.payload), true);
    } finally { exported.payload.fill(0); }
  }
});

test('closed export modes reject unknown or SSH gateway-default intentions', () => {
  for (const routingMode of ['global', 'direct', '', true, null]) {
    assert.throws(() => buildGenericExport({ ...input, routingMode }));
  }
  assert.throws(() => buildGenericExport({ ...input, adapterId: 'vscode_remote_ssh',
    routingMode: 'gateway-default' }));
});

test('MATCH is only accepted last and bound to the generated node', () => {
  const exported = buildGenericExport({ ...input, routingMode: 'gateway-default' });
  try {
    const text = exported.payload.toString();
    const terminal = text.trimEnd().split('\n').at(-1);
    assert.equal(validateGenericExportPayload(input.adapterId, Buffer.from(text + terminal + '\n')), false);
    assert.equal(validateGenericExportPayload(input.adapterId,
      Buffer.from(text.replace(terminal, '  - "MATCH,DIRECT"'))), false);
    assert.equal(validateGenericExportPayload(input.adapterId,
      Buffer.from(text.replace('rules:\n', `rules:\n${terminal}\n`))), false);
  } finally { exported.payload.fill(0); }
});
