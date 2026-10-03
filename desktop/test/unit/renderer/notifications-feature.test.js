'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/features/notifications/index.mjs');

class Element {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.dataset = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== callback));
  }
  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  focus() { this.focused = true; }
  querySelectorAll() { return this.focusables || []; }
  getClientRects() { return [{}]; }
  closest() { return null; }
}

function fixture({ reducedMotion = false, getLogsResult = 'synthetic log' } = {}) {
  const ids = ['notificationCard', 'notificationTitle', 'notificationSummary',
    'notificationAction', 'notificationDrawer', 'notificationBackdrop',
    'openNotificationDrawer', 'closeNotificationDrawer', 'logRefresh', 'logs'];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements.notificationDrawer.hidden = true;
  elements.notificationBackdrop.hidden = true;
  elements.diagnosticSummary = new Element();
  elements.diagnosticSummary.tagName = 'SUMMARY';
  elements.logRefresh.closest = () => ({});
  elements.notificationDrawer.focusables = [
    elements.closeNotificationDrawer, elements.diagnosticSummary, elements.logRefresh,
  ];
  const document = new Element();
  document.getElementById = (id) => elements[id] || null;
  document.activeElement = new Element();
  const calls = [];
  const timers = new Map();
  const frames = new Map();
  let sequence = 0;
  const ports = {
    document,
    translate: (key) => key,
    getLogs: () => { calls.push(['logs']); return getLogsResult; },
    openPage: (page) => calls.push(['page', page]),
    reconnect: async () => calls.push(['reconnect']),
    matchMedia: () => ({ matches: reducedMotion }),
    timers: {
      setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
  };
  const feature = create(ports);
  return { feature, document, elements, calls, timers, frames, ports };
}

test('notification owner preserves compact status presentation and known actions', async () => {
  const f = fixture();
  f.feature.start();
  const result = f.feature.renderStatus({
    lastError: 'synthetic error', recovery: { category: 'network', action: 'reconnect' },
  });
  assert.deepEqual(result, { category: 'network', action: 'reconnect' });
  assert.equal(f.elements.notificationTitle.textContent, 'notif.status.network');
  assert.equal(f.elements.notificationSummary.textContent, 'synthetic error');
  assert.equal(f.elements.notificationAction.dataset.action, 'reconnect');
  f.elements.notificationAction.dispatch('click');
  await Promise.resolve();
  assert.deepEqual(f.calls, [['page', 'connect'], ['reconnect']]);
  f.feature.dispose();
});

test('drawer opens, traps focus and closes back to its trigger after 180ms', () => {
  const f = fixture();
  const previousFocus = f.document.activeElement;
  f.feature.start();
  f.elements.openNotificationDrawer.dispatch('click');
  assert.equal(f.elements.notificationDrawer.hidden, false);
  assert.equal(f.elements.notificationBackdrop.hidden, false);
  assert.deepEqual(f.calls, [['logs']]);
  const frame = [...f.frames.values()][0];
  frame();
  assert.equal(f.elements.closeNotificationDrawer.focused, true);
  assert.equal(f.elements.notificationDrawer.classes.has('open'), true);
  f.document.activeElement = f.elements.diagnosticSummary;
  let prevented = 0;
  f.document.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  f.document.dispatch('keydown', { key: 'Escape', preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2);
  const [{ callback, delay }] = f.timers.values();
  assert.equal(delay, 180);
  callback();
  assert.equal(f.elements.notificationDrawer.hidden, true);
  assert.equal(previousFocus.focused, true);
  f.feature.dispose();
});

test('reduced motion uses zero delay and disposal retires listeners and scheduled work', () => {
  const f = fixture({ reducedMotion: true });
  assert.equal(f.feature.start(), true);
  assert.equal(f.feature.start(), false);
  f.elements.openNotificationDrawer.dispatch('click');
  f.elements.closeNotificationDrawer.dispatch('click');
  assert.equal([...f.timers.values()][0].delay, 0);
  const pending = [...f.timers.values()][0].callback;
  assert.equal(f.feature.dispose(), true);
  assert.equal(f.feature.dispose(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.elements.openNotificationDrawer.listeners.get('click').length, 0);
  assert.equal(f.document.listeners.get('keydown').length, 0);
  pending();
  assert.equal(f.elements.notificationDrawer.hidden, true);
});

test('diagnostic content remains inside the owner and late reads cannot update a retired view', async () => {
  let resolve;
  const pending = new Promise((finish) => { resolve = finish; });
  const f = fixture({ getLogsResult: pending });
  f.feature.start();
  f.feature.open();
  assert.equal(f.elements.logs.textContent, '');
  f.feature.dispose();
  resolve('synthetic late diagnostic');
  await pending;
  await Promise.resolve();
  assert.equal(f.elements.logs.textContent, '');

  const ready = fixture();
  ready.feature.start();
  ready.feature.open();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready.elements.logs.textContent, 'synthetic log');
  ready.feature.dispose();
});
