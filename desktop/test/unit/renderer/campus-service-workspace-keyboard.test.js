'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/campus-service-workspace');

function harness() {
  const nodes = new Map();
  const doc = { documentElement: { lang: 'en' }, activeElement: null,
    defaultView: { matchMedia: () => ({ matches: true }) } };
  function element(id = '') {
    const attributes = new Map();
    return { id, hidden: false, value: '', dataset: {}, tabIndex: -1, scrollTop: 0,
      handlers: new Map(), classList: { add() {}, remove() {} },
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      replaceChildren(...children) { this.children = children; },
      querySelector() { return null; },
      focus() { doc.activeElement = this; }, blur() { doc.activeElement = null; },
    };
  }
  doc.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  doc.createElement = () => element();
  const tablist = element('tablist'), content = element('content');
  doc.querySelector = selector => selector === '.ws-tabs' ? tablist : selector === '.content' ? content : null;
  const $ = doc.getElementById;
  const chip = element('official-chip');
  $('serviceOfficialView').querySelector = selector => selector === '.chip' ? chip : null;
  $('servicePersonalView').querySelector = selector => selector === '.pbtn' ? $('createCategory') : null;
  const noop = () => {};
  const feature = create({ document: doc, translate: key => key, escapeHtml: String,
    getServiceDesk: () => ({ applications: [], serviceItems: [], applicationGroups: [], serviceGroups: [] }),
    getPersonalCategories: () => [], openEntryUrl: noop, openDeepLink: noop, isEntryFavorite: () => false,
    onFavoriteEntry: noop, onCreateCategory: noop, onToggleOrganize: noop, focusPersonalCard: noop,
  });
  const tabs = { official: $('serviceTabOfficial'), personal: $('serviceTabPersonal') };
  feature.start();
  return { feature, doc, $, tabs, chip, content,
    key(key, target = doc.activeElement) {
      let prevented = false;
      tablist.handlers.get('keydown')({ key, target, preventDefault() { prevented = true; } });
      return prevented;
    } };
}

function assertSelection(h, expected) {
  assert.equal(h.feature.activeTab(), expected);
  assert.equal(h.doc.activeElement, h.tabs[expected]);
  for (const name of ['official', 'personal']) {
    assert.equal(h.tabs[name].getAttribute('aria-selected'), String(name === expected));
    assert.equal(h.tabs[name].tabIndex, name === expected ? 0 : -1);
    assert.equal(h.$(name === 'official' ? 'serviceOfficialView' : 'servicePersonalView').hidden, name !== expected);
  }
}

for (const [from, key, expected] of [
  ['official', 'Home', 'official'], ['official', 'End', 'personal'],
  ['official', 'ArrowLeft', 'personal'], ['official', 'ArrowRight', 'personal'],
  ['personal', 'Home', 'official'], ['personal', 'End', 'personal'],
  ['personal', 'ArrowLeft', 'official'], ['personal', 'ArrowRight', 'official'],
]) {
  test(`${key} from ${from} selects and focuses ${expected}`, () => {
    const h = harness(); h.feature.setTab(from, { focus: false }); h.tabs[from].focus();
    assert.equal(h.key(key), true);
    assertSelection(h, expected);
  });
}

test('navigation uses the focused owned tab, supports repeated arrows, and ignores unrelated keys/targets', () => {
  const h = harness(); h.feature.setTab('official', { focus: false }); h.tabs.personal.focus();
  h.key('ArrowRight'); assertSelection(h, 'official');
  for (const expected of ['personal', 'official', 'personal', 'official']) {
    h.key('ArrowRight'); assertSelection(h, expected);
  }
  for (const key of ['Tab', 'ArrowUp', 'ArrowDown', 'Escape', 'a']) {
    assert.equal(h.key(key), false); assertSelection(h, 'official');
  }
  assert.equal(h.key('Home', h.$('resourceSearch')), false);
  assertSelection(h, 'official');
});

test('keyboard navigation exits search without changing mouse or explicit no-focus behavior', () => {
  const h = harness(); h.feature.setTab('official', { focus: false });
  h.content.scrollTop = 30;
  h.$('resourceSearch').value = 'synthetic query'; h.$('resourceSearch').handlers.get('input')();
  h.content.scrollTop = 90; h.tabs.official.focus();
  assert.equal(h.feature.isSearching(), true);
  h.key('End'); assertSelection(h, 'personal');
  assert.equal(h.feature.isSearching(), false);
  assert.equal(h.$('resourceSearch').value, '');
  assert.equal(h.$('serviceSearchView').hidden, true);
  assert.equal(h.content.scrollTop, 90);
  h.tabs.official.handlers.get('click')(); assert.equal(h.doc.activeElement, h.chip);
  h.tabs.personal.handlers.get('click')(); assert.equal(h.doc.activeElement, h.$('createCategory'));
  h.tabs.personal.focus();
  h.feature.setTab('official', { focus: false });
  assert.equal(h.doc.activeElement, h.tabs.personal);
});
