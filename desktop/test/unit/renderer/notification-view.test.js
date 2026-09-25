'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyState, render, runAction } = require('../../../renderer/notification-view');

function fakeCard() {
  const values = new Set();
  return {
    values,
    classList: {
      toggle(name, enabled) {
        if (enabled) values.add(name);
        else values.delete(name);
      },
    },
  };
}

test('notification appearance follows connected busy and terminal error state', () => {
  const card = fakeCard();
  assert.equal(applyState(card, { connected: true }), true);
  assert.deepEqual([...card.values], ['connected']);
  applyState(card, { connecting: true });
  assert.deepEqual([...card.values], ['busy']);
  applyState(card, { lastError: 'Gateway unavailable' });
  assert.deepEqual([...card.values], ['error']);
  applyState(card, {});
  assert.deepEqual([...card.values], []);
});

test('notification appearance fails closed without a usable card', () => {
  assert.equal(applyState(null, { lastError: 'x' }), false);
});

test('notification renderer uses public recovery categories instead of parsing error text', () => {
  const card = fakeCard();
  const title = { textContent: '' };
  const summary = { textContent: '' };
  const action = { textContent: '', hidden: true, dataset: {} };
  const value = render({
    card, title, summary, action,
    state: {
      lastError: '本地化技术说明',
      recovery: { category: 'local-listener', action: 'open-tower' },
    },
    translate: (key) => key,
  });
  assert.deepEqual(value, { category: 'local-listener', action: 'open-tower' });
  assert.equal(title.textContent, 'notif.status.local-listener');
  assert.equal(summary.textContent, '本地化技术说明');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, 'notif.action.open-tower');
});

test('notification recovery actions open only known product surfaces', async () => {
  const calls = [];
  const dependencies = {
    openPage: (page) => calls.push(['page', page]),
    reconnect: async () => calls.push(['reconnect']),
  };
  assert.equal(await runAction('open-settings', dependencies), true);
  assert.equal(await runAction('open-tower', dependencies), true);
  assert.equal(await runAction('reconnect', dependencies), true);
  assert.equal(await runAction('unknown', dependencies), false);
  assert.deepEqual(calls, [
    ['page', 'settings'], ['page', 'tower'], ['page', 'connect'], ['reconnect'],
  ]);
});
