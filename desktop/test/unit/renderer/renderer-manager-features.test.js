'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRoutingHostInput,
  routeStackSlots,
  routingGroups,
  routingRulesForView,
} = require('../../../renderer/routing-manager');
const { certificatePinsForView } = require('../../../renderer/certificate-manager');

const translate = (key) => key;

test('routing and certificate managers carry their own bounded view helpers', () => {
  const routing = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', '..', 'renderer', 'routing-manager.js'), 'utf8');
  const certificates = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', '..', 'renderer', 'certificate-manager.js'), 'utf8');
  for (const source of [routing, certificates]) {
    assert.match(source, /function escapeHtml\(/u);
    assert.match(source, /function operationError\(/u);
    assert.match(source, /function collectionFromResult\(/u);
  }
  assert.match(certificates, /function formatManagerTime\(/u);
  assert.doesNotMatch(routing + certificates, /manager-view/u,
    'the legacy shared manager view is retired (DESIGN.md §2)');
});

test('routing manager accepts full web URLs and drops untrusted view fields', () => {
  assert.equal(normalizeRoutingHostInput(' Login.Example.Test. ', translate), 'login.example.test');
  assert.equal(normalizeRoutingHostInput(
    'https://hpc2login.hpc.hkust-gz.edu.cn/login?next=%2F', translate,
  ), 'hpc2login.hpc.hkust-gz.edu.cn');
  for (const invalid of ['', 'file:///tmp/x', '*.example.test', 'a..b']) {
    assert.throws(() => normalizeRoutingHostInput(invalid, translate), /routing\.invalidHost/);
  }
  assert.deepEqual(routingRulesForView([{
    host: 'x.example.test',
    includeSubdomains: false,
    route: 'direct',
    updatedAt: 10,
    token: 'forbidden',
  }]), [{
    host: 'x.example.test', includeSubdomains: false, route: 'direct', updatedAt: 10,
  }]);
  const rules = routingRulesForView([
    { host: 'campus.example.test', includeSubdomains: true, route: 'campus' },
    { host: 'direct.example.test', includeSubdomains: false, route: 'direct' },
  ]);
  assert.deepEqual(routingGroups(rules, translate).map(({ id, items }) => [id, items.length]),
    [['campus', 1], ['direct', 1]]);
  assert.equal(routeStackSlots(439), 1);
  assert.equal(routeStackSlots(440), 2);
});

test('certificate manager exposes only origin fingerprint and timestamp', () => {
  assert.deepEqual(certificatePinsForView([{
    origin: 'https://campus.example.test',
    fingerprint: 'A'.repeat(64),
    updatedAt: 20,
    certificatePem: 'forbidden',
    subject: 'forbidden',
  }]), [{
    origin: 'https://campus.example.test',
    fingerprint: 'a'.repeat(64),
    updatedAt: 20,
  }]);
});
