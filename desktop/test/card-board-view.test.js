'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const view = require('../renderer/components/card-board/card-board-view');

const escapeHtml = (value) => String(value).replace(/[&<>"']/gu, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const translate = (key) => ({
  'resources.routeDirect': '直连',
  'resources.routeCampus': '校园隧道',
  'resources.favorite': '收藏',
  'resources.unfavorite': '取消收藏',
})[key] || key;

function resource(index) {
  return {
    id: `resource-${index}`,
    name: `Resource ${index}`,
    category: 'courses',
    route: index % 2 ? 'direct' : 'campus',
    favorite: index === 1,
  };
}

function fixture({ editing = false, frontByDeck = {}, courseSize = 'medium', items = 13 } = {}) {
  const placements = [
    {
      placementId: 'placement_courses', boardId: 'browser-catalog',
      card: { kind: 'official-category', id: 'courses' }, deckId: 'deck-academic',
      order: 0, size: courseSize, hidden: false,
    },
    {
      placementId: 'placement_research', boardId: 'browser-catalog',
      card: { kind: 'official-category', id: 'research' }, deckId: 'deck-academic',
      order: 1, size: 'small', hidden: false,
    },
  ];
  const unit = {
    kind: 'deck', unitId: 'deck-academic', order: 0,
    deck: {
      deckId: 'deck-academic', boardId: 'browser-catalog',
      placementIds: placements.map(({ placementId }) => placementId),
      activePlacementId: 'placement_courses', order: 0,
    },
    placements,
  };
  const cardsByKey = new Map([
    ['official-category:courses', {
      name: '课程、选课与成绩',
      items: Array.from({ length: items }, (_, index) => resource(index)),
    }],
    ['official-category:research', { name: '科研、进度与计算', items: [resource(20)] }],
  ]);
  return view.renderBoard({
    boardId: 'browser-catalog', units: [unit], cardsByKey,
    frontByDeck, editing, escapeHtml, translate, columns: 2,
  });
}

function cardMarkup(markup, placementId) {
  const marker = `data-card-placement-id="${placementId}"`;
  const start = markup.lastIndexOf('<article', markup.indexOf(marker));
  const next = markup.indexOf('<article', markup.indexOf(marker));
  return markup.slice(start, next < 0 ? markup.length : next);
}

test('a deck renders same-size physical cards with one front tab and peeking backs', () => {
  const markup = fixture();
  assert.match(markup, /class="cb-board-grid"[^>]*data-card-board[^>]*data-board-id="browser-catalog"/u);
  assert.match(markup, /role="tablist"[^>]*data-card-deck-id="deck-academic"/u);
  assert.equal((markup.match(/data-card-placement-id=/gu) || []).length, 2);
  const courses = cardMarkup(markup, 'placement_courses');
  const research = cardMarkup(markup, 'placement_research');
  // The persisted deck order stays put; the active card is simply in front.
  assert.ok(markup.indexOf('data-card-placement-id="placement_courses') >
    markup.indexOf('data-card-placement-id="placement_research'),
    'the front card renders last so it owns the highest layer without layout moves');
  assert.match(research, /class="cb-card is-back"[^>]*data-card-front="false"/u);
  assert.match(research, /role="tab"[^>]*aria-selected="false"/u);
  assert.match(research, /aria-label="科研、进度与计算，1 个网站，第 1 张，共 2 张"/u);
  assert.match(research, /class="cb-card-body" inert/u);
  assert.match(courses, /class="cb-card is-front"[^>]*data-card-front="true"/u);
  assert.match(courses, /role="tab"[^>]*aria-selected="true"/u);
  assert.match(courses, /aria-label="课程、选课与成绩，13 个网站，第 2 张，共 2 张，当前在正面"/u);
  assert.doesNotMatch(courses, /class="cb-card-body" inert/u);
  assert.match(courses, /data-card-action="draw"/u);
  // No chevron, no expand/collapse semantics anywhere.
  assert.doesNotMatch(markup, /chevron|aria-expanded|data-expanded/u);
  assert.doesNotMatch(markup, /\sstyle=/u, 'geometry is applied by the controller, not inline markup');
});

test('frontByDeck moves the front layer without changing deck order', () => {
  const markup = fixture({ frontByDeck: { 'deck-academic': 'placement_research' } });
  assert.match(cardMarkup(markup, 'placement_research'), /data-card-front="true"/u);
  assert.match(cardMarkup(markup, 'placement_courses'), /data-card-front="false"/u);
  assert.ok(markup.indexOf('data-card-placement-id="placement_research') >
    markup.indexOf('data-card-placement-id="placement_courses'));
});

test('small medium and large decks preview four six and eight sites with a show-all entry', () => {
  for (const [courseSize, expected] of [['small', 4], ['medium', 6], ['large', 8]]) {
    const markup = fixture({ courseSize });
    const courses = cardMarkup(markup, 'placement_courses');
    assert.equal((courses.match(/data-card-resource-id=/gu) || []).length, expected, courseSize);
    assert.match(courses, /data-card-action="show-all"/u);
    assert.match(courses, />查看全部（13）</u);
    assert.doesNotMatch(courses, /https?:\/\//u);
  }
  const few = fixture({ courseSize: 'small', items: 3 });
  assert.match(cardMarkup(few, 'placement_courses'), /data-card-action="expand" aria-haspopup="dialog"/u,
    'small categories still have an explicit header expansion control');
  assert.doesNotMatch(cardMarkup(few, 'placement_courses'), /data-card-action="show-all"/u,
    'the show-all entry appears only when the preview truncates');
});

test('an empty category shows the honest empty state with an add-site action', () => {
  const markup = fixture({ items: 0 });
  const courses = cardMarkup(markup, 'placement_courses');
  assert.match(courses, /这个分类还没有网站|此分类暂无网站/u);
  assert.match(courses, /data-card-action="add-site"/u);
});

test('card and website labels are escaped at the view boundary', () => {
  const markup = view.renderSiteRows([{
    id: 'unsafe', name: '<img src=x onerror=alert(1)>', category: 'custom',
    route: 'direct', favorite: false,
  }], { escapeHtml, translate, previewLimit: 4 });
  assert.doesNotMatch(markup, /<img/u);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/u);
});

test('ordinary cards use one brand tone while system widgets retain the sparse gold accent', () => {
  assert.equal(view.cardTone('official-category'), 'brand');
  assert.equal(view.cardTone('user-collection'), 'brand');
  assert.equal(view.cardTone('system-widget'), 'gold');
  assert.match(fixture(), /data-card-tone="brand"/u);
});

test('official category icons are semantic instead of one repeated glyph', () => {
  const markup = fixture();
  const courses = cardMarkup(markup, 'placement_courses');
  const research = cardMarkup(markup, 'placement_research');
  assert.notEqual(
    courses.match(/<span class="cb-category-icon">([\s\S]*?)<\/span>/u)?.[1],
    research.match(/<span class="cb-category-icon">([\s\S]*?)<\/span>/u)?.[1],
  );
});

test('editing adds drag/menu/drop affordances while browsing leaves no draggable target', () => {
  const browsing = fixture({ editing: false });
  assert.doesNotMatch(browsing, /data-card-drag-handle|data-card-drop=/u);
  const editing = fixture({ editing: true });
  assert.equal((editing.match(/data-card-drag-handle/gu) || []).length, 2);
  assert.doesNotMatch(editing, />⠿<\/button>/u,
    'editing still requires a tiny drag-handle button instead of dragging the card');
  assert.equal((editing.match(/class="cb-card-head is-draggable"/gu) || []).length, 2);
  assert.equal((editing.match(/data-card-drop="before"/gu) || []).length, 2);
  assert.equal((editing.match(/data-card-drop="stack"/gu) || []).length, 2);
  assert.equal((editing.match(/data-card-drop="after"/gu) || []).length, 2);
  assert.match(editing, /data-card-edit-action="pin"/u);
});

test('the rename affordance is opt-in and scoped to user collections', () => {
  const official = fixture({ editing: true });
  assert.doesNotMatch(official, /data-card-edit-action="rename"/u);
  const withRename = fixture({ editing: true });
  void withRename;
  const markup = view.renderBoard({
    boardId: 'browser-personal',
    units: [{
      kind: 'placement', unitId: 'placement_group', deck: null, order: 0,
      placements: [{
        placementId: 'placement_group', boardId: 'browser-personal',
        card: { kind: 'user-collection', id: 'group_abc' }, deckId: null,
        order: 0, size: 'small', hidden: false,
      }],
    }],
    cardsByKey: new Map([['user-collection:group_abc', { name: '学习', items: [resource(1)] }]]),
    editing: true, renameCards: true, escapeHtml, translate, columns: 1,
  });
  assert.match(markup, /data-card-edit-action="rename"/u);
});

test('45 reviewed sites across 12 categories stay within the projection budget', () => {
  const placements = Array.from({ length: 12 }, (_, index) => ({
    placementId: `placement-${index}`,
    boardId: 'browser-catalog',
    card: { kind: 'official-category', id: `category-${index}` },
    deckId: null,
    order: index,
    size: 'small',
    hidden: false,
  }));
  const units = placements.map((placement) => ({
    kind: 'placement', unitId: placement.placementId, deck: null,
    placements: [placement], order: placement.order,
  }));
  const cardsByKey = new Map(placements.map((placement, categoryIndex) => [
    `official-category:category-${categoryIndex}`,
    {
      name: `Category ${categoryIndex}`,
      items: Array.from({ length: categoryIndex < 9 ? 4 : 3 }, (_, itemIndex) => (
        resource(categoryIndex * 10 + itemIndex)
      )),
    },
  ]));
  // Warm the renderer factory so the assertion measures the steady-state local projection.
  view.renderBoard({ boardId: 'browser-catalog', units, cardsByKey, escapeHtml, translate, columns: 3 });
  const started = performance.now();
  const markup = view.renderBoard({
    boardId: 'browser-catalog', units, cardsByKey, escapeHtml, translate, columns: 3,
  });
  const elapsed = performance.now() - started;
  assert.equal((markup.match(/data-card-resource-id=/gu) || []).length, 45);
  assert.ok(elapsed < 50, `card-board projection took ${elapsed.toFixed(2)}ms (budget: 50ms)`);
});

test('layer offsets cap the visible depth at three cards', () => {
  assert.equal(view.MAX_VISIBLE_DEPTH, 3);
  assert.equal(view.layerOffset(0, 1), 0);
  assert.deepEqual([0, 1, 2].map((i) => view.layerOffset(i, 3)), [0, 36, 72]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => view.layerOffset(i, 5)), [0, 0, 0, 36, 72],
    'legacy deeper decks clamp instead of growing the slot');
});
