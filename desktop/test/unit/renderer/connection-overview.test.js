'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildUnderlayOptions, networkPathSummary, sparkline } = require('../../../renderer/connection-overview');

test('latency sparkline is bounded and stable for empty and noisy samples', () => {
  assert.equal(sparkline([]), 'M2 24 L118 24');
  const path = sparkline([18, 22, 19, 4000, -2]);
  assert.match(path, /^M2\.0 \d+\.\d(?: L\d+\.\d \d+\.\d){4}$/u);
  for (const coordinate of path.match(/\d+\.\d/gu).map(Number)) {
    assert.ok(Number.isFinite(coordinate));
  }
});

test('network tree groups selectable source addresses by adapter without losing exact selection', () => {
  const environment = {
    defaultRoute: { interfaceId: 'en0', sourceAddress: '192.0.2.10' },
    selection: { mode: 'default', interfaceId: 'en0', sourceAddress: '', available: true },
    interfaces: [
      { id: 'en0', name: 'Wi-Fi', kind: 'physical', active: true, default: true,
        addresses: [{ address: '192.0.2.10', selectable: true }] },
      { id: 'utun4', name: 'Tailscale', kind: 'virtual', active: true, default: false,
        addresses: [
          { address: '100.64.0.2', family: 4, selectable: true,
            publicEgress: { status: 'ready', address: '104.16.1.4', relation: 'different' } },
          { address: 'fd7a:115c:a1e0::1', family: 6, selectable: true,
            publicEgress: { status: 'unavailable', relation: 'unknown' } },
        ] },
    ],
  };
  const t = (key) => key;
  const options = buildUnderlayOptions(environment, t);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map(({ interfaceId, selected, sources }) => ({
    interfaceId, selected, values: sources.map(({ value }) => value),
  })), [
    { interfaceId: 'en0', selected: true, values: [''] },
    { interfaceId: 'utun4', selected: false,
      values: ['100.64.0.2', 'fd7a:115c:a1e0::1'] },
  ]);
  environment.selection = { mode: 'selected', interfaceId: 'utun4',
    sourceAddress: '100.64.0.2', available: true };
  assert.equal(buildUnderlayOptions(environment, t)[0].selected, true,
    'the explicitly selected interface is promoted without splitting its addresses into cards');
  assert.equal(buildUnderlayOptions(environment, t)[0].sources[0].selected, true);
  environment.selection.available = false;
  assert.equal(buildUnderlayOptions(environment, t).some(({ selected }) => selected), false);

  environment.interfaces.push({ id: 'mirror0', name: 'Mirror', kind: 'virtual', active: true,
    default: false, addresses: [{ address: '100.64.0.2', family: 4, selectable: true }] });
  assert.equal(buildUnderlayOptions(environment, t).length, 3,
    'the same source address on two interfaces must not hide either interface card');
});

test('connection overview exposes one compact adapter tree instead of duplicate network diagnostics', () => {
  const renderer = path.join(__dirname, '..', '..', '..', 'renderer');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
  for (const id of ['networkPathDetails', 'currentNetworkExit', 'networkTree', 'underlayTreeOptions', 'tunnelSummary']) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'));
  }
  assert.match(html, /<details id="networkPathDetails"[^>]*>[\s\S]*class="network-topology"/u);
  for (const removed of [
    'defaultAdapterName', 'virtualAdapterSummary', 'underlaySourceAddress',
    'systemRouteName', 'systemProxyName',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removed}"`, 'u'));
  }
  assert.match(html, /network-tree-compact/u);
  assert.doesNotMatch(html, /network-tree-branches/u);
  assert.match(html, /data-topology-node="tunnel"/u);
  assert.match(app, /connectionOverview\.start\(\{[^\n]*save:\s*\(patch\)\s*=>\s*window\.api\.save/u);
  assert.match(app, /refresh:\s*\(\)\s*=>\s*refreshState/u);
});

test('connection summary speaks in adapter and public-exit terms', () => {
  const options = [{
    interfaceId: 'en0', title: 'Wi-Fi · en0', selected: true,
    sources: [{ value: '', localAddress: '192.0.2.10', selected: true,
      publicEgress: { status: 'ready', address: '203.0.113.8', relation: 'baseline' } }],
  }];
  const t = (key, vars = {}) => key === 'connect.defaultDirectShort' ? '默认直连'
    : key === 'connect.publicEgressValue' ? `公网出口 ${vars.address}` : key;
  assert.deepEqual(networkPathSummary(options, t), {
    title: 'Wi-Fi · en0',
    detail: '公网出口 203.0.113.8 · 默认直连',
  });
});
