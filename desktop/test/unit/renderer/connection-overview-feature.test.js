'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/connection-overview/index.mjs');

function fakeNode(document, tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  let textContent = '';
  const node = {
    tagName: tagName.toUpperCase(), id: '', dataset: {}, children: [], innerHTML: '',
    hidden: false, disabled: false, focusCount: 0, replaceChildrenCount: 0,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
      toggle(value, force) {
        if (force === undefined ? !classes.has(value) : force) classes.add(value);
        else classes.delete(value);
        return classes.has(value);
      },
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
  Object.defineProperty(node, 'textContent', {
    get() { return textContent; },
    set(value) { textContent = String(value); },
  });
  return node;
}

function documentFixture() {
  const document = { hidden: false, activeElement: null };
  const ids = new Map();
  for (const id of [
    'copyTunnelIp', 'stIp', 'underlayTreeOptions', 'tunnelSummary', 'notificationAttention',
    'currentNetworkExit', 'currentNetworkExitHint', 'networkPathDetailsSummary',
    'underlaySelectionStatus', 'latencySparkline', 'statGrid', 'appsCard', 'latencyMetric',
    'latencyHint', 'stDur', 'stPing', 'stConn', 'stDns', 'appList',
    'power', 'powerLabel', 'connStatus', 'connIp', 'connTop', 'connErr',
  ]) {
    const node = fakeNode(document, id === 'copyTunnelIp' ? 'button' : 'div');
    node.id = id;
    ids.set(id, node);
  }
  ids.get('stIp').textContent = '192.0.2.10';
  const topology = fakeNode(document, 'section');
  topology.dataset.status = 'inactive';
  const controlStatus = fakeNode(document, 'div');
  document.getElementById = id => ids.get(id) || null;
  document.querySelector = selector => selector === '[data-topology-node="tunnel"]'
    ? topology : selector === '.conn-status' ? controlStatus : null;
  document.createElement = tagName => fakeNode(document, tagName);
  return { document, ids, topology, controlStatus };
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
  const intervals = new Map();
  let nextTimer = 0;
  const timers = {
    setTimeout(callback) { const id = ++nextTimer; scheduled.set(id, callback); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    scheduled,
    intervals,
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
    escapeHtml: value => String(value).replace(/[&<>\"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;',
    }[character])),
    ...overrides,
  });
  return { owner, timers };
}

test('connection detail owner renders supplied status and telemetry with the existing timer contract', () => {
  const f = documentFixture();
  let now = 91_000;
  const t = (key, values = {}) => key === 'stats.connectionCount' ? `${key}:${values.count}` : key;
  const { owner, timers } = ownerFor(f.document, { now: () => now });

  owner.renderStatus({
    connected: true, connecting: false, clientIp: '192.0.2.10', dnsMode: 'gateway', connectedAt: 1_000,
  }, t);
  assert.equal(f.ids.get('statGrid').hidden, false);
  assert.equal(f.ids.get('appsCard').hidden, false);
  assert.equal(f.ids.get('stIp').textContent, '192.0.2.10');
  assert.equal(f.ids.get('stDns').textContent, 'stats.dnsGateway');
  assert.equal(f.ids.get('stDur').textContent, '1:30');
  assert.equal(timers.intervals.size, 1);
  const [firstTimer, interval] = [...timers.intervals.entries()][0];
  assert.equal(interval.delay, 1_000);

  owner.renderTelemetry({
    connectedAt: 25_000, latencyMs: 32.4, connCount: 3,
    apps: [{ name: '<sample&"app>', count: 2 }],
  }, t);
  assert.equal(f.ids.get('stPing').textContent, '32 ms');
  assert.equal(f.ids.get('stConn').textContent, '3');
  assert.match(f.ids.get('appList').innerHTML, /&lt;sample&amp;&quot;app&gt;/u);
  assert.match(f.ids.get('appList').innerHTML, /stats\.connectionCount:2/u);
  assert.equal(timers.intervals.size, 1, 'telemetry alone does not start or replace the duration ticker');

  now = 85_000;
  interval.callback();
  assert.equal(f.ids.get('stDur').textContent, '1:00',
    'the existing ticker reads the latest telemetry timestamp');
  assert.equal(timers.intervals.has(firstTimer), true);
});

test('connection control card projects connected, busy and error states without owning commands', () => {
  const f = documentFixture();
  const { owner } = ownerFor(f.document);
  owner.renderStatus({ connected: false, connecting: false, clientIp: '192.0.2.10',
    lastError: 'Synthetic error' });
  assert.equal(f.ids.get('powerLabel').textContent, 'connect.actionConnect');
  assert.equal(f.ids.get('power').getAttribute('aria-checked'), 'false');
  assert.equal(f.ids.get('connStatus').textContent, 'connect.disconnected');
  assert.equal(f.ids.get('connIp').textContent, '—');
  assert.equal(f.ids.get('connErr').textContent, 'Synthetic error');

  owner.renderStatus({ connected: true, connecting: false, clientIp: '192.0.2.10' });
  assert.equal(f.ids.get('powerLabel').textContent, 'connect.actionDisconnect');
  assert.equal(f.ids.get('power').getAttribute('aria-checked'), 'true');
  assert.equal(f.ids.get('power').disabled, false);
  assert.equal(f.ids.get('connStatus').textContent, 'connect.connected');
  assert.equal(f.ids.get('connIp').textContent, '192.0.2.10');
  assert.equal(f.ids.get('connErr').textContent, '');
  assert.equal(f.controlStatus.classList.contains('on'), true);
  assert.equal(f.ids.get('connTop').classList.contains('connected'), true);

  owner.renderStatus({ connected: false, connecting: true, lastError: 'Hidden while busy' });
  assert.equal(f.ids.get('power').disabled, true);
  assert.equal(f.ids.get('powerLabel').textContent, 'connect.actionConnecting');
  assert.equal(f.ids.get('connStatus').textContent, 'connect.connecting');
  assert.equal(f.ids.get('connErr').textContent, '');
  assert.equal(f.controlStatus.classList.contains('busy'), true);
  owner.dispose();
  owner.renderStatus({ connected: false, connecting: false });
  assert.equal(f.ids.get('connStatus').textContent, 'connect.connecting',
    'a retired owner cannot repaint the card');
});

test('status owns duration interval replacement, disconnect reset, and terminal retirement', () => {
  const f = documentFixture();
  let now = 95_000;
  const { owner, timers } = ownerFor(f.document, { now: () => now });
  owner.renderTelemetry({ connectedAt: 3_000 });
  assert.equal(timers.intervals.size, 0, 'telemetry alone does not create a duration ticker');
  owner.renderStatus({ connected: true, connectedAt: 5_000, clientIp: '192.0.2.10' });
  const firstTimer = [...timers.intervals.keys()][0];
  owner.renderStatus({ connected: true, clientIp: '192.0.2.10' });
  assert.equal(timers.intervals.size, 1);
  const [currentTimer] = [...timers.intervals.entries()][0];
  assert.notEqual(currentTimer, firstTimer, 'each connected status update restarts the original interval');

  owner.renderTelemetry({ connectedAt: 15_000, latencyMs: 20, connCount: 4, apps: [{ name: 'app', count: 4 }] });
  assert.equal(timers.intervals.has(currentTimer), true, 'telemetry does not re-arm the interval');
  owner.renderStatus({ connected: false, connecting: false });
  assert.equal(timers.intervals.size, 0);
  assert.equal(f.ids.get('stDur').textContent, '0:00');
  assert.equal(f.ids.get('stPing').textContent, '—');
  assert.equal(f.ids.get('stConn').textContent, '0');
  assert.equal(f.ids.get('appList').innerHTML, '');
  assert.equal(f.ids.get('appsCard').hidden, true);
  assert.equal(f.ids.get('latencyHint').hidden, false,
    'the disconnected non-connecting hint follows the original status projection');

  owner.renderStatus({ connected: true, connectedAt: 20_000 });
  const retired = [...timers.intervals.values()][0];
  owner.dispose();
  const duration = f.ids.get('stDur').textContent;
  now = 99_000;
  retired.callback();
  assert.equal(timers.intervals.size, 0);
  assert.equal(f.ids.get('stDur').textContent, duration,
    'a captured ticker callback is inert after owner disposal');
});

test('zero-valued duration interval handles are replaced and cleared on disposal', () => {
  const f = documentFixture();
  const { owner, timers } = ownerFor(f.document);
  const cleared = [];
  timers.setInterval = (callback, delay) => {
    timers.intervals.set(0, { callback, delay });
    return 0;
  };
  timers.clearInterval = handle => {
    cleared.push(handle);
    timers.intervals.delete(handle);
  };

  owner.renderStatus({ connected: true, connectedAt: 1_000 });
  const firstCallback = timers.intervals.get(0).callback;
  owner.renderStatus({ connected: true });
  assert.deepEqual(cleared, [0]);
  assert.equal(timers.intervals.size, 1);
  assert.equal(timers.intervals.has(0), true);

  const activeCallback = timers.intervals.get(0).callback;
  owner.dispose();
  assert.deepEqual(cleared, [0, 0]);
  const duration = f.ids.get('stDur').textContent;
  firstCallback();
  activeCallback();
  assert.equal(f.ids.get('stDur').textContent, duration);
});

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
