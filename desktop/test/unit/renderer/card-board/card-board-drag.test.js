'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { attach, dropPosition } = require('../../../../renderer/components/card-board/card-board-drag');

function classList() {
  const values = new Set();
  return {
    add: (value) => values.add(value),
    remove: (value) => values.delete(value),
    contains: (value) => values.has(value),
  };
}

function makeBoard({ editing = false } = {}) {
  const listeners = new Map();
  const cards = [];
  const container = {
    dataset: { editing: String(editing) },
    classList: classList(),
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    querySelectorAll(selector) {
      return selector === '[data-card-placement-id]' ? cards : [];
    },
  };
  function addCard(placementId, rect = { top: 100, height: 100 }) {
    const attributes = new Map();
    const handle = {
      closest(selector) { return selector === '[data-card-drag-handle]' ? handle
        : selector === '[data-card-placement-id]' ? card : null; },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
    };
    const card = {
      dataset: { cardPlacementId: placementId, dragging: 'false' },
      getBoundingClientRect: () => rect,
      contains: () => false,
      closest(selector) { return selector === '[data-card-placement-id]' ? card : null; },
      querySelector(selector) { return selector === '[data-card-drag-handle]' ? handle : null; },
    };
    cards.push(card);
    return { card, handle };
  }
  return { container, listeners, addCard };
}

function dataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    values: new Map(),
    setData(type, value) { this.values.set(type, value); },
  };
}

test('drop geometry reserves 24/52/24 percent for before, stack, and after', () => {
  const card = { getBoundingClientRect: () => ({ top: 100, height: 100 }) };
  assert.equal(dropPosition(card, 100), 'before');
  assert.equal(dropPosition(card, 123), 'before');
  assert.equal(dropPosition(card, 124), 'stack');
  assert.equal(dropPosition(card, 176), 'stack');
  assert.equal(dropPosition(card, 177), 'after');
  assert.equal(dropPosition(card, 200), 'after');
});

test('ordinary browsing mode refuses pointer drag before any layout mutation', () => {
  const board = makeBoard({ editing: false });
  const source = board.addCard('source');
  let prevented = false;
  let drops = 0;
  attach({ container: board.container, onDrop: () => { drops += 1; } });
  const transfer = dataTransfer();
  board.listeners.get('dragstart')({
    target: source.handle,
    dataTransfer: transfer,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(source.card.dataset.dragging, 'false');
  assert.equal(board.container.classList.contains('cb-is-dragging'), false);
  assert.equal(transfer.values.size, 0);
  assert.equal(drops, 0);
});

test('editing drag reports insertion and stack zones without mutating DOM order', () => {
  for (const [clientY, expectedPosition] of [[110, 'before'], [150, 'stack'], [190, 'after']]) {
    const board = makeBoard({ editing: true });
    const source = board.addCard('source');
    const target = board.addCard('target');
    const drops = [];
    attach({ container: board.container, onDrop: (drop) => drops.push(drop) });
    const transfer = dataTransfer();
    board.listeners.get('dragstart')({
      target: source.handle, dataTransfer: transfer, preventDefault() {},
    });
    assert.equal(source.card.dataset.dragging, 'true');
    assert.equal(transfer.values.get('text/plain'), 'source');
    board.listeners.get('dragover')({
      target: target.card, clientY, dataTransfer: transfer, preventDefault() {},
    });
    assert.equal(target.card.dataset.cardDropTarget, expectedPosition);
    board.listeners.get('drop')({
      target: target.card, dataTransfer: transfer, preventDefault() {},
    });
    assert.deepEqual(drops, [{
      sourcePlacementId: 'source', targetPlacementId: 'target', position: expectedPosition,
    }]);
    assert.equal(source.card.dataset.dragging, 'false');
    assert.equal(board.container.classList.contains('cb-is-dragging'), false);
    assert.deepEqual(board.container.querySelectorAll('[data-card-placement-id]')
      .map(({ dataset }) => dataset.cardPlacementId), ['source', 'target']);
  }
});

test('keyboard pickup supports movement and Escape with live announcements', () => {
  const board = makeBoard({ editing: true });
  const source = board.addCard('source');
  const moves = [];
  const messages = [];
  attach({
    container: board.container,
    onDrop: () => {},
    onKeyboardMove: (move) => moves.push(move),
    announce: (message) => messages.push(message),
  });
  const key = (value) => board.listeners.get('keydown')({
    target: source.handle, key: value, preventDefault() {},
  });
  key(' ');
  assert.equal(source.handle.getAttribute('aria-pressed'), 'true');
  key('ArrowRight');
  assert.deepEqual(moves, [{ placementId: 'source', direction: 'ArrowRight' }]);
  key('Escape');
  assert.equal(source.handle.getAttribute('aria-pressed'), 'false');
  assert.match(messages[0], /拿起/u);
  assert.match(messages.at(-1), /取消/u);
});
