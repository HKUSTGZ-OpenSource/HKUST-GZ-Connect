'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const renderer = path.join(__dirname, '../../../../renderer');
const boardModel = require('../../../../renderer/components/card-board/card-board-model');
const boardView = require('../../../../renderer/components/card-board/card-board-view');
const { localeStrings } = require('../../../../renderer/components/card-board/card-board-controller');

function harness() {
  const nodes = new Map(), boards = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      dataset: {}, classList: { add() {}, toggle() {} }, addEventListener() {},
      setAttribute() {}, replaceChildren() {}, prepend() {}, closest() { return this; },
      querySelector(selector) {
        return id === 'groupDialog' && selector === 'form' ? node('groupDialog form') : null;
      },
    });
    return nodes.get(id);
  };
  const document = {
    documentElement: {}, getElementById: node, querySelector: node,
    querySelectorAll: () => [], createElement: () => node(Symbol()), addEventListener() {},
  };
  let receiveState;
  const window = {
    campusWorkspaceModel: require('../../../../renderer/campus-workspace-model'),
    cardBoardModel: boardModel,
    cardBoardController: { create(options) {
      const board = { options, categories: [] };
      boards.push(board);
      return {
        setData({ categories }) { board.categories = categories; },
        isEditing: () => false, load: async () => null,
      };
    } },
    campusWorkspace: { onState(fn) { receiveState = fn; }, onFocus() {}, command: () => true },
    addEventListener() {},
  };
  const context = vm.createContext({
    window, self: window, document, innerWidth: 1040,
    ResizeObserver: class { observe() {} },
  });
  for (const file of ['components/card-board/campus-workspace-board.js', 'campus-workspace.js']) {
    vm.runInContext(fs.readFileSync(path.join(renderer, file), 'utf8'), context, { filename: file });
  }
  const resources = [
    { id: 'synthetic-course', name: 'Synthetic Course', category: 'courses', route: 'campus', builtin: true, favorite: true, lastOpenedAt: null },
    { id: 'synthetic-tool', name: 'Synthetic Tool', category: 'tools', route: 'direct', builtin: true, favorite: false, lastOpenedAt: null },
  ];
  return { document, boards, repaint(locale) {
    receiveState({ locale, schoolName: 'Synthetic School', resources,
      groups: [{ id: 'group_abcdefghijkl', name: 'Synthetic category', resourceIds: ['synthetic-course'] }] });
  } };
}

test('Browser Workspace page and actual board bridge localize More after locale redraws', async () => {
  const { createT } = await import(pathToFileURL(path.join(renderer, 'features/localization/index.mjs')));
  const fixture = harness();
  for (const locale of ['zh', 'en', 'zh']) {
    fixture.repaint(locale);
    assert.equal(fixture.boards.length, 2, 'locale redraw must reuse both board controllers');
    const expected = createT(locale)('workspace.more');
    assert.notEqual(expected, 'workspace.more');
    for (const { options, categories } of fixture.boards) {
      const document = boardModel.defaultDocument({ [options.boardId]: categories.map(({ id, kind }) => ({ id, kind })) });
      const markup = boardView.renderBoard({
        ...options, units: boardModel.boardUnits(document, options.boardId),
        cardsByKey: new Map(categories.map(card => [`${card.kind}:${card.id}`, card])),
        strings: localeStrings(fixture.document),
      });
      assert.ok(markup.includes(`>${expected}</button>`), `${locale} ${options.boardId}: More must match canonical localization`);
      assert.doesNotMatch(markup, />workspace\.more</u);
      assert.equal(options.translate('resources.favorite'), locale === 'en' ? 'Favorite' : '收藏');
      assert.equal(options.translate('resources.unfavorite'), locale === 'en' ? 'Remove favorite' : '取消收藏');
    }
  }
});
