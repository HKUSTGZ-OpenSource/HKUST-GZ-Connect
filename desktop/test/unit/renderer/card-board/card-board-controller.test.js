'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const model = require('../../../../renderer/components/card-board/card-board-model');
const {
  createMemoryAdapter,
  dropOperationsForDocument,
  localeStrings,
  resultDocument,
} = require('../../../../renderer/components/card-board/card-board-controller');

function card(kind, id) {
  return { kind, id };
}

function placement(document, id) {
  return document.placements.find(({ card: ref }) => ref.id === id);
}

test('memory adapter preserves revision-bound atomic editing semantics', async () => {
  const initial = model.defaultDocument({
    'browser-catalog': [{ kind: 'official-category', id: 'courses' }],
  });
  const placement = initial.placements[0];
  const adapter = createMemoryAdapter(initial);
  const committed = await adapter.commit({
    baseRevision: 0,
    operations: [{ type: 'resize-placement', placementId: placement.placementId, size: 'large' }],
  });
  assert.equal(committed.changed, true);
  assert.equal(committed.document.revision, 1);
  assert.equal(committed.document.placements[0].size, 'large');
  await assert.rejects(adapter.commit({
    baseRevision: 0,
    operations: [{ type: 'hide-placement', placementId: placement.placementId }],
  }), (error) => error?.code === 'CARD_BOARD_REVISION_CONFLICT');
  const afterConflict = await adapter.get();
  assert.equal(afterConflict.document.revision, 1);
  assert.equal(afterConflict.document.placements[0].hidden, false);
});

test('reset is revision-bound and clears layout without mutating a prior snapshot', async () => {
  const initial = model.defaultDocument({
    'browser-personal': [{ kind: 'user-collection', id: 'study' }],
  });
  const adapter = createMemoryAdapter(initial);
  const before = await adapter.get();
  const reset = await adapter.reset({ baseRevision: 0 });
  assert.deepEqual(reset.document, {
    schemaVersion: 1, revision: 1, placements: [], decks: [],
  });
  assert.equal(before.document.placements.length, 1,
    'reset mutated the snapshot already projected into the renderer');
});

test('controller accepts only bounded layout result envelopes', () => {
  const document = { schemaVersion: 1, revision: 0, placements: [], decks: [] };
  assert.equal(resultDocument({ document }), document);
  assert.equal(resultDocument({ layout: document }), document);
  assert.equal(resultDocument(document), document);
  assert.equal(resultDocument({ ok: true }), null);
  assert.equal(resultDocument(null), null);
});

test('editing labels are complete in Chinese and English', () => {
  const zh = localeStrings({ documentElement: { lang: 'zh-CN' } });
  const en = localeStrings({ documentElement: { lang: 'en' } });
  for (const key of [
    'edit', 'done', 'cancel', 'undo', 'redo', 'reset', 'saveFailed', 'stale',
    'dragCard', 'resizeCard', 'renameCard', 'pinToConnect', 'removeFromConnect', 'hideCard',
    'showAll', 'cardAria', 'cardAriaFront', 'deckAria', 'addSite',
  ]) {
    assert.ok(zh[key], `missing Chinese ${key}`);
    assert.ok(en[key], `missing English ${key}`);
    assert.notEqual(zh[key], en[key], `${key} was not localized`);
  }
});

test('drop insertion compensates for a source removed before its target', () => {
  const initial = model.defaultDocument({
    'browser-catalog': [
      card('official-category', 'courses'),
      card('official-category', 'research'),
      card('official-category', 'labs'),
    ],
  });
  const courses = placement(initial, 'courses');
  const labs = placement(initial, 'labs');
  const before = dropOperationsForDocument(initial, {
    sourcePlacementId: courses.placementId,
    targetPlacementId: labs.placementId,
    position: 'before',
  });
  const beforeResult = model.applyDraftOperations(initial, before);
  assert.deepEqual(model.boardUnits(beforeResult, 'browser-catalog')
    .flatMap(({ placements }) => placements.map(({ card: ref }) => ref.id)), [
    'research', 'courses', 'labs',
  ]);

  const after = dropOperationsForDocument(initial, {
    sourcePlacementId: courses.placementId,
    targetPlacementId: labs.placementId,
    position: 'after',
  });
  const afterResult = model.applyDraftOperations(initial, after);
  assert.deepEqual(model.boardUnits(afterResult, 'browser-catalog')
    .flatMap(({ placements }) => placements.map(({ card: ref }) => ref.id)), [
    'research', 'labs', 'courses',
  ]);
});

test('stacking onto a full three-card deck degrades to an insertion', () => {
  let document = model.defaultDocument({
    'browser-catalog': [
      card('official-category', 'courses'),
      card('official-category', 'research'),
      card('official-category', 'labs'),
      card('official-category', 'tools'),
      card('official-category', 'career'),
    ],
  });
  const at = (id) => document.placements.find(({ card: ref }) => ref.id === id);
  document = model.applyDraftOperation(document, {
    type: 'create-deck', boardId: 'browser-catalog',
    placementIds: ['courses', 'research', 'labs'].map((id) => at(id).placementId),
    activePlacementId: at('labs').placementId, index: 0,
  });
  const full = dropOperationsForDocument(document, {
    sourcePlacementId: at('tools').placementId,
    targetPlacementId: at('labs').placementId,
    position: 'stack',
  });
  assert.ok(full.every(({ type }) => type !== 'move-into-deck'),
    'a fourth card must not enter a full deck (DESIGN.md §10: at most three per deck)');
  const applied = model.applyDraftOperations(document, full);
  assert.equal(applied.decks[0].placementIds.length, 3);
});
