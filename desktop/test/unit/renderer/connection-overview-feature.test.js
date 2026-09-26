'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/connection-overview/index.mjs');

function fakeNode(document, tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  const node = {
    tagName: tagName.toUpperCase(), id: '', dataset: {}, children: [], textContent: '', innerHTML: '',
    hidden: false, disabled: false, focusCount: 0, replaceChildrenCount: 0,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener(type, callback) {
      const current = listeners.get(type) || [];
      current.push(callback);
      listeners.set(type, current);
    },
    removeEventListener(type, callback) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== callback));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    async dispatch(type, event = {}) {
      const callbacks = [...(listeners.get(type) || [])];
      return Promise.all(callbacks.map(callback => callback({ ...event, target: event.target || node, currentTarget: node })));
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.replaceChildrenCount += 1; node.children = children; },
    querySelectorAll(selector) {
      const matches = [];
      const visit = parent => {
        for (const child of parent.children || []) {
          if (selector === 'button' && child.tagName === 'BUTTON') matches.push(child);
          if (selector === '[data-underlay-address]' && Object.hasOwn(child.dataset || {}, 'underlayAddress')) matches.push(child);
          visit(child);
        }
      };
      visit(node);
      return matches;
    },
    focus() { node.focusCount += 1; document.activeElement = node; },
  };
  return node;
}

function documentFixture() {
  const document = { hidden: false, activeElement: null };
  const ids = new Map();
  for (const id of [
    'copyTunnelIp', 'stIp', 'underlayTreeOptions', 'tunnelSummary', 'notificationAttention',
    'currentNetworkExit', 'currentNetworkExitHint', 'networkPathDetailsSummary',
    'underlaySelectionStatus', 'latencySparkline',
  ]) {
    const node = fakeNode(document, id === 'copyTunnelIp' ? 'button' : 'div');
    node.id = id;
    ids.set(id, node);
  }
  ids.get('stIp').textContent = '192.0.2.10';
  const topology = fakeNode(document, 'section');
  topology.dataset.status = 'inactive';
  document.getElementById = id => ids.get(id) || null;
  document.querySelector = selector => selector === '[data-topology-node="tunnel"]' ? topology : null;
  document.createElement = tagName => fakeNode(document, tagName);
  return { document, ids, topology };
}

function environmentFixture() {
  return {
    defaultRoute: { interfaceId: 'en0', sourceAddress: '192.0.2.10' },
    selection: { mode: 'selected', interfaceId: 'utun4', sourceAddress: '100.64.0.2', available: true },
    interfaces: [
      { id: 'en0', name: 'Wi-Fi', kind: 'physical', active: true, default: true,
        addresses: [{ address: '192.0.2.10', family: 4, selectable: true }] },
      { id: 'utun4', name: 'VPN', kind: 'virtual', active: true, default: false,
        addresses: [{ address: '100.64.0.2', family: 4, selectable: true,
          publicEgress: { status: 'ready', address: '203.0.113.8', relation: 'different' } }] },
    ],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function ownerFor(document, overrides = {}) {
  const scheduled = new Map();
  let nextTimer = 0;
  const timers = {
    setTimeout(callback) { const id = ++nextTimer; scheduled.set(id, callback); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    scheduled,
  };
  const owner = create({
    document,
    translate: key => key,
    copy: async () => {},
    save: async () => ({ ok: true }),
    refresh: async () => {},
    getEnvironment: async () => environmentFixture(),
    subscribeEnvironment: () => () => {},
    timers,
    ...overrides,
  });
  return { owner, timers };
}

test('connection overview preserves underlay focus and renders only while mounted', () => {
  const f = documentFixture();
  let environmentListener;
  let unsubscribeCount = 0;
  const { owner } = ownerFor(f.document, {
    subscribeEnvironment: callback => { environmentListener = callback; return () => { unsubscribeCount += 1; }; },
  });
  assert.equal(owner.start(), true);
  assert.equal(owner.start(), false);
  owner.renderEnvironment(environmentFixture());
  const options = f.ids.get('underlayTreeOptions');
  const selected = options.querySelectorAll('[data-underlay-address]')
    .find(button => button.dataset.underlayAddress === '100.64.0.2');
  assert.ok(selected);
  selected.focus();
  owner.renderEnvironment(environmentFixture());
  assert.equal(f.document.activeElement.dataset.underlayAddress, '100.64.0.2');
  assert.equal(f.document.activeElement.focusCount, 1);
  owner.renderStatus({ connected: true, connecting: false, lastError: null, notice: null });
  assert.equal(f.topology.dataset.status, 'healthy');
  assert.equal(f.ids.get('tunnelSummary').textContent, 'connect.tunnelReady');

  assert.equal(owner.dispose(), true);
  assert.equal(owner.dispose(), false);
  assert.equal(unsubscribeCount, 1);
  assert.equal(f.ids.get('copyTunnelIp').listenerCount('click'), 0);
  assert.equal(options.listenerCount('click'), 0);
  const replaceCount = options.replaceChildrenCount;
  environmentListener(environmentFixture());
  owner.renderEnvironment(environmentFixture());
  owner.renderStatus({ connected: false });
  owner.renderTelemetry({ latencyMs: 32 });
  assert.equal(options.replaceChildrenCount, replaceCount);
  assert.equal(f.topology.dataset.status, 'healthy');
});

test('a network environment read completing after dispose cannot render or publish stale data', async () => {
  const f = documentFixture();
  const pending = deferred();
  const { owner } = ownerFor(f.document, { getEnvironment: () => pending.promise });
  owner.start();
  const request = owner.refreshEnvironment();
  await Promise.resolve();
  const replaceCount = f.ids.get('underlayTreeOptions').replaceChildrenCount;
  owner.dispose();
  pending.resolve(environmentFixture());
  assert.equal(await request, null);
  assert.equal(f.ids.get('underlayTreeOptions').replaceChildrenCount, replaceCount);
});

test('dispose before a queued environment read starts prevents the Main API call', async () => {
  const f = documentFixture();
  let calls = 0;
  const { owner } = ownerFor(f.document, { getEnvironment: () => { calls += 1; return environmentFixture(); } });
  owner.start();
  const request = owner.refreshEnvironment();
  owner.dispose();
  assert.equal(await request, null);
  assert.equal(calls, 0);
});

test('underlay save completing after dispose cannot mutate DOM or refresh Main state', async () => {
  const f = documentFixture();
  const pending = deferred();
  let refreshCount = 0;
  const { owner } = ownerFor(f.document, {
    save: patch => { assert.deepEqual(patch, { underlaySourceAddress: '100.64.0.2' }); return pending.promise; },
    refresh: () => { refreshCount += 1; },
  });
  owner.start();
  const environment = environmentFixture();
  environment.selection = { mode: 'default', interfaceId: 'en0', sourceAddress: '', available: true };
  owner.renderEnvironment(environment);
  const options = f.ids.get('underlayTreeOptions');
  const button = options.querySelectorAll('[data-underlay-address]')
    .find(item => item.dataset.underlayAddress === '100.64.0.2');
  const operation = options.dispatch('click', { target: { closest: () => button } });
  assert.equal(f.ids.get('underlaySelectionStatus').textContent, 'connect.applyingUnderlay');
  owner.dispose();
  const status = f.ids.get('underlaySelectionStatus').textContent;
  pending.resolve({ ok: true });
  await operation;
  assert.equal(f.ids.get('underlaySelectionStatus').textContent, status);
  assert.equal(refreshCount, 0);
});

test('copy completion and feedback timeout retire without post-dispose DOM writes', async () => {
  const f = documentFixture();
  const pending = deferred();
  const { owner, timers } = ownerFor(f.document, { copy: () => pending.promise });
  owner.start();
  const copy = f.ids.get('copyTunnelIp');
  const operation = copy.dispatch('click');
  owner.dispose();
  const originalText = copy.textContent;
  pending.resolve();
  await operation;
  assert.equal(copy.textContent, originalText);
  assert.equal(timers.scheduled.size, 0);

  const f2 = documentFixture();
  const { owner: timedOwner, timers: timers2 } = ownerFor(f2.document, { copy: async () => {} });
  timedOwner.start();
  await f2.ids.get('copyTunnelIp').dispatch('click');
  const feedback = f2.ids.get('copyTunnelIp').textContent;
  assert.equal(feedback, 'connect.copied');
  const callback = [...timers2.scheduled.values()][0];
  assert.equal(typeof callback, 'function');
  timedOwner.dispose();
  assert.equal(timers2.scheduled.size, 0);
  callback();
  assert.equal(f2.ids.get('copyTunnelIp').textContent, feedback);
});

test('partial startup failure unsubscribes and removes listeners before preserving the primary error', () => {
  const f = documentFixture();
  const primary = new Error('synthetic underlay listener failure');
  let unsubscribeCount = 0;
  f.ids.get('underlayTreeOptions').addEventListener = () => { throw primary; };
  const { owner } = ownerFor(f.document, {
    subscribeEnvironment: () => () => { unsubscribeCount += 1; },
  });
  assert.throws(() => owner.start(), error => error === primary);
  assert.equal(unsubscribeCount, 1);
  assert.equal(f.ids.get('copyTunnelIp').listenerCount('click'), 0);
  assert.equal(owner.dispose(), false);
});
