'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { create } = require('../../../renderer/campus-service-workspace');

function harness() {
  let desk={applications:[],serviceItems:[],applicationGroups:[],serviceGroups:[]};
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
    getServiceDesk: () => desk,
    getPersonalCategories: () => [], openEntryUrl: noop, openDeepLink: noop, isEntryFavorite: () => false,
    onFavoriteEntry: noop, onCreateCategory: noop, onToggleOrganize: noop, focusPersonalCard: noop,
  });
  const tabs = { official: $('serviceTabOfficial'), personal: $('serviceTabPersonal') };
  feature.start();
  return { feature, doc, $, tabs, chip, content, setDesk: value => {desk=value;},
    key(key, target = doc.activeElement) {
      let prevented = false;
      tablist.handlers.get('keydown')({ key, target, preventDefault() { prevented = true; } });
      return prevented;
    } };
}


test('render reprojects an active search without clearing its query or moving input focus', () => {
  const h=harness(),input=h.$('resourceSearch');
  h.setDesk({applications:[{id:'synthetic-old',name:'Synthetic Portal',aliases:['retirement']}],
    serviceItems:[],applicationGroups:[],serviceGroups:[]});
  input.value='retirement'; input.focus(); input.handlers.get('input')();
  assert.match(h.$('searchResults').innerHTML,/Synthetic Portal/u);
  h.setDesk({applications:[],serviceItems:[],applicationGroups:[],serviceGroups:[]});
  h.feature.render();
  assert.doesNotMatch(h.$('searchResults').innerHTML,/Synthetic Portal/u);
  assert.equal(input.value,'retirement');
  assert.equal(h.feature.isSearching(),true);
  assert.equal(h.doc.activeElement,input);
});
